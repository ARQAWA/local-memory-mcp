import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetConfig } from "../../src/config.js";
import { closeDb, getDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { MemoryRepository } from "../../src/repositories/memory.repository.js";
import { RelationRepository } from "../../src/repositories/relation.repository.js";
import { DedupService } from "../../src/services/dedup.service.js";
import { resetGitIdentityCache } from "../../src/services/git-identity.service.js";
import { MemoryService } from "../../src/services/memory.service.js";
import { resetEmbeddingProvider } from "../../src/services/embedding.service.js";
import type { Reranker, RerankCandidateInput, RerankResult } from "../../src/services/reranker.service.js";
import type { CardType, MemoryStatus, MemoryType } from "../../src/types/memory.js";

let dir: string | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "local-memory-card-test-"));
  process.env["LOCAL_MEMORY_DB_PATH"] = join(dir, "test.sqlite3");
  process.env["LOCAL_MEMORY_REPOSITORY_ROOT"] = dir;
  process.env["EMBEDDING_PROVIDER"] = "noop";
  resetConfig();
  resetEmbeddingProvider();
  resetGitIdentityCache();
});

afterEach(async () => {
  await closeDb();
  resetConfig();
  resetEmbeddingProvider();
  resetGitIdentityCache();
  delete process.env["LOCAL_MEMORY_DB_PATH"];
  delete process.env["LOCAL_MEMORY_REPOSITORY_ROOT"];
  delete process.env["EMBEDDING_PROVIDER"];
  delete process.env["LOCAL_MEMORY_LIBRARIAN_MODE"];
  delete process.env["LOCAL_MEMORY_LIBRARIAN_CMD"];
  delete process.env["LOCAL_MEMORY_LIBRARIAN_TIMEOUT_MS"];
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

async function ensureRepo(repo: MemoryRepository, slug: string) {
  return repo.ensureRepository({
    repository_name: slug,
    repository_slug: slug,
    repository_root: `/tmp/${slug}`,
    repository_root_hash: createHash("sha256").update(slug).digest("hex"),
    repository_identity_kind: "folder",
  });
}

async function createMemory(
  repo: MemoryRepository,
  repositoryId: string,
  content: string,
  options?: {
    memoryType?: MemoryType;
    cardType?: CardType;
    status?: MemoryStatus;
    tags?: string[];
    importance?: number;
  },
) {
  const memory = await repo.create({
    repository_id: repositoryId,
    user_id: "test-user",
    memory_type: options?.memoryType ?? "fact",
    card_type: options?.cardType,
    status: options?.status,
    content,
    summary: content.slice(0, 80),
    importance: options?.importance ?? 0.7,
    created_by: "test",
    source: "test",
    supersedes: null,
  });
  if (options?.tags?.length) await repo.setTags(memory.id, options.tags, repositoryId);
  return memory;
}

class TestReranker implements Reranker {
  calls: { query: string; candidates: RerankCandidateInput[] }[] = [];
  private readonly order?: string[] | undefined;

  constructor(order?: string[]) {
    this.order = order;
  }

  async start(): Promise<void> {
    return Promise.resolve();
  }

  async rerank(query: string, candidates: RerankCandidateInput[]): Promise<RerankResult[]> {
    this.calls.push({ query, candidates });
    const ordered = this.order
      ? this.order
          .map((id) => candidates.find((candidate) => candidate.id === id))
          .filter((item): item is RerankCandidateInput => Boolean(item))
      : [...candidates];
    const rest = candidates.filter((candidate) => !ordered.some((item) => item.id === candidate.id));
    return [...ordered, ...rest].map((candidate, index) => ({ id: candidate.id, score: 1 - index }));
  }

  async healthCheck(): Promise<RerankResult[]> {
    return [{ id: "ok", score: 1 }];
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

describe("project memory cards", () => {
  test("migration preserves old ids and linked legacy tables", async () => {
    if (!dir) throw new Error("missing temp dir");
    const db = getDb();
    db.exec(readFileSync(join(process.cwd(), "src/db/migrations/001_schema.sql"), "utf-8"));
    db.exec(readFileSync(join(process.cwd(), "src/db/migrations/002_access_count_indexes.sql"), "utf-8"));
    db.exec(
      "CREATE TABLE _migrations (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')))",
    );
    db.run("INSERT INTO _migrations (name) VALUES (?)", ["001_schema.sql"]);
    db.run("INSERT INTO _migrations (name) VALUES (?)", ["002_access_count_indexes.sql"]);

    const repositoryId = "11111111-1111-4111-8111-111111111111";
    const firstId = "22222222-2222-4222-8222-222222222222";
    const secondId = "33333333-3333-4333-8333-333333333333";
    const entityId = "44444444-4444-4444-8444-444444444444";
    db.run(
      `INSERT INTO repositories (id, slug, name, root_path, root_hash, metadata)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        repositoryId,
        "legacy-repo",
        "legacy-repo",
        "/tmp/legacy-repo",
        createHash("sha256").update("legacy").digest("hex"),
        '{"identity_kind":"folder"}',
      ],
    );
    db.run(
      `INSERT INTO memories (id, repository_id, user_id, memory_type, content, summary, importance, created_by, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [firstId, repositoryId, "user", "decision", "Legacy decision content", "Legacy decision", 0.8, "legacy", "old"],
    );
    db.run(
      `INSERT INTO memories (id, repository_id, user_id, memory_type, content, summary, importance, created_by, source, supersedes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        secondId,
        repositoryId,
        "user",
        "procedure",
        "Legacy process content",
        "Legacy process",
        0.7,
        "legacy",
        "old",
        firstId,
      ],
    );
    db.run("INSERT INTO memory_tags (memory_id, repository_id, tag) VALUES (?, ?, ?)", [
      firstId,
      repositoryId,
      "legacy",
    ]);
    db.run("INSERT INTO entities (id, repository_id, name, entity_type) VALUES (?, ?, ?, ?)", [
      entityId,
      repositoryId,
      "LegacyEntity",
      "concept",
    ]);
    db.run("INSERT INTO memory_entities (memory_id, repository_id, entity_id) VALUES (?, ?, ?)", [
      firstId,
      repositoryId,
      entityId,
    ]);
    db.run(
      `INSERT INTO memory_relations (id, repository_id, source_memory_id, target_memory_id, relation_type)
       VALUES (?, ?, ?, ?, ?)`,
      ["55555555-5555-4555-8555-555555555555", repositoryId, secondId, firstId, "depends_on"],
    );
    db.run("INSERT INTO audit_log (id, repository_id, memory_id, action, actor) VALUES (?, ?, ?, ?, ?)", [
      "66666666-6666-4666-8666-666666666666",
      repositoryId,
      firstId,
      "create",
      "legacy",
    ]);
    const vector = `[${new Array<number>(256).fill(0.01).join(",")}]`;
    db.run(
      `INSERT INTO memory_vectors(memory_pk, repository_pk, embedding)
       SELECT m.pk, r.pk, ?
       FROM memories m JOIN repositories r ON r.id = m.repository_id
       WHERE m.id = ?`,
      [vector, firstId],
    );

    await runMigrations();

    const migrated = db.get<{
      id: string;
      card_type: string;
      status: string;
      source_type: string;
      confidence: number;
      supersedes_id: string | null;
    }>("SELECT id, card_type, status, source_type, confidence, supersedes_id FROM memories WHERE id = ?", [secondId]);
    expect(migrated).toEqual({
      id: secondId,
      card_type: "process",
      status: "current",
      source_type: "legacy_import",
      confidence: 0.75,
      supersedes_id: firstId,
    });
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM memory_tags")?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM entities")?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM memory_entities")?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM memory_relations")?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM audit_log")?.count).toBe(1);
    expect(db.get<{ count: number }>("SELECT COUNT(*) AS count FROM memory_vectors")?.count).toBe(1);
    expect(readdirSync(join(dir, "backups")).some((file) => file.includes("003_project_memory_cards"))).toBe(true);
  });

  test("prepare_context deep applies status sections and drops wrong cards", async () => {
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "status-repo");
    const rule = await createMemory(repo, repository.id, "Never store secrets in memory", {
      memoryType: "convention",
      cardType: "constraint",
      status: "current",
    });
    const legacy = await createMemory(repo, repository.id, "Old Postgres architecture decision", {
      memoryType: "decision",
      cardType: "decision",
      status: "deprecated",
    });
    const wrong = await createMemory(repo, repository.id, "Wrong security advice", {
      memoryType: "fact",
      cardType: "fact",
      status: "wrong",
    });

    const result = await new MemoryService({ reranker: new TestReranker() }).prepareContext({
      task: "security architecture migration",
      mode: "deep",
      repository: repository.slug,
    });

    expect(result.mode_used).toBe("deep");
    expect(result.used_memory_ids).toContain(rule.id);
    expect(result.used_memory_ids).toContain(legacy.id);
    expect(result.used_memory_ids).not.toContain(wrong.id);
    expect(result.sections["Hard rules"]?.join("\n")).toContain("Never store secrets");
    expect(result.sections["Legacy"]?.join("\n")).toContain("Old Postgres");
    expect(result.context_pack).not.toContain("Wrong security advice");
  });

  test("light mode does not expand relations but deep mode does", async () => {
    await runMigrations();
    const repo = new MemoryRepository();
    const relations = new RelationRepository();
    const repository = await ensureRepo(repo, "relation-repo");
    const seed = await createMemory(repo, repository.id, "alpha seed decision", {
      memoryType: "decision",
      cardType: "decision",
    });
    const neighbor = await createMemory(repo, repository.id, "neighbor-only architecture note", {
      memoryType: "reference",
      cardType: "architecture",
    });
    await relations.create({
      repository_id: repository.id,
      source_id: seed.id,
      target_id: neighbor.id,
      relation_type: "related_to",
      description: "deep context relation",
    });

    const reranker = new TestReranker();
    const service = new MemoryService({ reranker });
    const light = await service.prepareContext({ task: "alpha", mode: "light", repository: repository.slug });
    const deep = await service.prepareContext({ task: "alpha migration", mode: "deep", repository: repository.slug });

    expect(light.used_memory_ids).toContain(seed.id);
    expect(light.used_memory_ids).not.toContain(neighbor.id);
    expect(deep.used_memory_ids).toContain(neighbor.id);
    expect(reranker.calls).toHaveLength(2);
  });

  test("auto mode uses deep retrieval for auth security migration tasks", async () => {
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "auto-repo");
    await createMemory(repo, repository.id, "Auth migration architecture card", {
      memoryType: "reference",
      cardType: "architecture",
    });

    const result = await new MemoryService({ reranker: new TestReranker() }).prepareContext({
      task: "auth security migration review",
      mode: "auto",
      repository: repository.slug,
    });

    expect(result.mode_used).toBe("deep");
  });

  test("light mode calls mandatory reranker and reranker can change order", async () => {
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "rerank-repo");
    const first = await createMemory(repo, repository.id, "alpha low priority", {
      memoryType: "fact",
      cardType: "fact",
      importance: 0.2,
    });
    const second = await createMemory(repo, repository.id, "alpha high priority", {
      memoryType: "fact",
      cardType: "fact",
      importance: 0.9,
    });
    const reranker = new TestReranker([first.id, second.id]);

    const result = await new MemoryService({ reranker }).prepareContext({
      task: "alpha",
      mode: "light",
      repository: repository.slug,
    });

    expect(reranker.calls).toHaveLength(1);
    expect(reranker.calls[0]?.candidates.length).toBeGreaterThanOrEqual(2);
    expect(result.used_memory_ids.slice(0, 2)).toEqual([first.id, second.id]);
  });

  test("prepare_context fails when backend has no mandatory reranker", async () => {
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "missing-reranker-repo");
    await createMemory(repo, repository.id, "alpha memory", {
      memoryType: "fact",
      cardType: "fact",
    });

    await expect(
      new MemoryService().prepareContext({
        task: "alpha",
        mode: "light",
        repository: repository.slug,
      }),
    ).rejects.toThrow("memory is not operational without Jina MLX reranker");
  });

  test("librarian auto command failures fall back to local prepare_context", async () => {
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "fallback-repo");
    await createMemory(repo, repository.id, "Fallback architecture memory", {
      memoryType: "reference",
      cardType: "architecture",
    });
    process.env["LOCAL_MEMORY_LIBRARIAN_MODE"] = "auto";
    process.env["LOCAL_MEMORY_LIBRARIAN_CMD"] = 'node -e "process.exit(2)"';

    const result = await new MemoryService({ reranker: new TestReranker() }).prepareContext({
      task: "architecture migration",
      mode: "deep",
      repository: repository.slug,
      use_librarian: "auto",
    });

    expect(result.context_pack).toContain("Fallback architecture memory");
    expect(result.mode_used).toBe("deep");
  });

  test("librarian off mode does not call configured command", async () => {
    if (!dir) throw new Error("missing temp dir");
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "librarian-off-repo");
    await createMemory(repo, repository.id, "Off mode local memory", {
      memoryType: "reference",
      cardType: "architecture",
    });

    const tracePath = join(dir, "librarian-off-called.txt");
    process.env["LOCAL_MEMORY_LIBRARIAN_MODE"] = "off";
    process.env["LOCAL_MEMORY_LIBRARIAN_CMD"] = `node -e "require('node:fs').writeFileSync(${JSON.stringify(
      tracePath,
    )}, 'called')"`;

    const result = await new MemoryService({ reranker: new TestReranker() }).prepareContext({
      task: "off mode local",
      mode: "light",
      repository: repository.slug,
      use_librarian: "auto",
    });

    expect(result.context_pack).toContain("Off mode local memory");
    expect(() => readFileSync(tracePath, "utf-8")).toThrow();
  });

  test("librarian always command failure is a clear error", async () => {
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "librarian-error-repo");
    await createMemory(repo, repository.id, "Architecture memory", {
      memoryType: "reference",
      cardType: "architecture",
    });
    process.env["LOCAL_MEMORY_LIBRARIAN_MODE"] = "always";
    process.env["LOCAL_MEMORY_LIBRARIAN_CMD"] = 'node -e "process.exit(2)"';

    await expect(
      new MemoryService({ reranker: new TestReranker() }).prepareContext({
        task: "architecture migration",
        mode: "deep",
        repository: repository.slug,
        use_librarian: "always",
      }),
    ).rejects.toThrow("Librarian subagent");
  });

  test("librarian always uses live command output and receives JSON input", async () => {
    if (!dir) throw new Error("missing temp dir");
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "librarian-live-command-repo");
    await createMemory(repo, repository.id, "Live command candidate memory", {
      memoryType: "reference",
      cardType: "architecture",
    });

    const tracePath = join(dir, "librarian-input.json");
    const commandPath = join(dir, "librarian-command.mjs");
    writeFileSync(
      commandPath,
      `import { writeFileSync } from "node:fs";

const tracePath = process.argv[2];
let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync(tracePath, input);
  process.stdout.write(JSON.stringify({
    sections: { "Librarian": ["Live librarian memory pack"] },
    used_memory_ids: [],
    confidence: 0.98,
    missing_info: []
  }));
});
`,
    );
    process.env["LOCAL_MEMORY_LIBRARIAN_MODE"] = "always";
    process.env["LOCAL_MEMORY_LIBRARIAN_CMD"] =
      `${shellQuote(process.execPath)} ${shellQuote(commandPath)} ${shellQuote(tracePath)}`;

    const result = await new MemoryService({ reranker: new TestReranker() }).prepareContext({
      task: "architecture migration",
      mode: "deep",
      repository: repository.slug,
      use_librarian: "always",
    });

    expect(result.context_pack).toContain("Live librarian memory pack");
    expect(result.confidence).toBe(0.98);
    const payload = JSON.parse(readFileSync(tracePath, "utf-8")) as {
      task: string;
      mode: string;
      candidates: { text: string }[];
    };
    expect(payload.task).toBe("architecture migration");
    expect(payload.mode).toBe("deep");
    expect(payload.candidates.some((candidate) => candidate.text.includes("Live command candidate memory"))).toBe(true);
  });

  test("commit_task writes durable cards once", async () => {
    await runMigrations();
    const service = new MemoryService();
    const first = await service.commitTask({
      task_summary: "Implement project memory",
      decisions: ["Use project memory cards for task context"],
      changed_files: ["src/services/memory.service.ts"],
    });
    const second = await service.commitTask({
      task_summary: "Implement project memory",
      decisions: ["Use project memory cards for task context"],
      changed_files: ["src/services/memory.service.ts"],
    });

    expect(first.created).toBe(1);
    expect(second.created).toBe(0);
    expect(second.skipped_duplicates).toBe(1);
    const memory = await new MemoryRepository().findById(first.written_memory_ids[0] ?? "");
    expect(memory?.memory_type).toBe("decision");
    expect(memory?.card_type).toBe("decision");
  });

  test("commit_task reports merged cards without duplicate written ids", async () => {
    await runMigrations();
    const service = new MemoryService();
    const first = await service.commitTask({
      task_summary: "Implement project memory",
      decisions: ["Use project memory cards for task context"],
    });
    const firstId = first.written_memory_ids[0];
    if (!firstId) throw new Error("missing first memory id");

    const dedup = new DedupService();
    dedup.findDuplicates = async () => ({ action: "merge", existing_id: firstId, similarity: 0.99 });
    const mergeService = new MemoryService({ dedup });
    const merged = await mergeService.commitTask({
      task_summary: "Implement project memory",
      decisions: ["Use compact project memory cards for task context"],
    });

    expect(merged.created).toBe(0);
    expect(merged.skipped_duplicates).toBe(1);
    expect(merged.written_memory_ids).toEqual([firstId]);
  });

  test("correct_memory changes status without changing the memory id", async () => {
    await runMigrations();
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "correct-repo");
    const memory = await createMemory(repo, repository.id, "Candidate fact", {
      memoryType: "fact",
      cardType: "fact",
      status: "candidate",
    });

    const updated = await new MemoryService().correctMemory({
      id: memory.id,
      action: "mark_wrong",
      repository: repository.slug,
    });

    expect(updated?.id).toBe(memory.id);
    expect(updated?.status).toBe("wrong");
    expect(updated?.confidence).toBe(0);
  });
});

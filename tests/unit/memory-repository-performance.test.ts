import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { resetConfig } from "../../src/config.js";
import { closeDb, getDb } from "../../src/db/connection.js";
import { runMigrations } from "../../src/db/migrate.js";
import { MemoryRepository } from "../../src/repositories/memory.repository.js";
import type { MemoryType } from "../../src/types/memory.js";

let dir: string | null = null;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "local-memory-repo-test-"));
  process.env["LOCAL_MEMORY_DB_PATH"] = join(dir, "test.sqlite3");
  resetConfig();
  await runMigrations();
});

afterEach(async () => {
  await closeDb();
  resetConfig();
  delete process.env["LOCAL_MEMORY_DB_PATH"];
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

async function createMemory(repo: MemoryRepository, repositoryId: string, content: string, type: MemoryType = "fact") {
  return repo.create({
    repository_id: repositoryId,
    user_id: "test-user",
    memory_type: type,
    content,
    summary: content.slice(0, 80),
    importance: 0.5,
    created_by: "test",
    source: "test",
    supersedes: null,
  });
}

describe("memory repository performance paths", () => {
  test("getStats returns true most accessed memories", async () => {
    const repo = new MemoryRepository();
    const repository = await ensureRepo(repo, "stats-repo");
    const low = await createMemory(repo, repository.id, "new low access");
    const high = await createMemory(repo, repository.id, "old high access");

    getDb().run("UPDATE memories SET access_count = 1, updated_at = ? WHERE id = ?", [
      "2030-01-01T00:00:00.000Z",
      low.id,
    ]);
    getDb().run("UPDATE memories SET access_count = 9, updated_at = ? WHERE id = ?", [
      "2020-01-01T00:00:00.000Z",
      high.id,
    ]);

    const stats = await repo.getStats(repository.id);

    expect(stats.most_accessed.map((memory) => memory.id)).toEqual([high.id, low.id]);
  });

  test("adminListMemories searches through FTS and keeps filters", async () => {
    const repo = new MemoryRepository();
    const firstRepo = await ensureRepo(repo, "admin-first");
    const secondRepo = await ensureRepo(repo, "admin-second");
    const expected = await createMemory(repo, firstRepo.id, "alpha needle phrase", "decision");
    await createMemory(repo, firstRepo.id, "alpha other phrase", "fact");
    await createMemory(repo, secondRepo.id, "alpha needle phrase", "decision");

    const result = repo.adminListMemories({
      search: "needle",
      memoryType: "decision",
      repository: firstRepo.slug,
      limit: 10,
      offset: 0,
    });

    expect(result.total).toBe(1);
    expect(result.memories).toEqual([
      expect.objectContaining({
        id: expected.id,
        repository: firstRepo.slug,
        memory_type: "decision",
      }),
    ]);
  });
});

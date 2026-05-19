import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { resetConfig } from "../src/config.js";
import { closeDb, getDb } from "../src/db/connection.js";
import { runMigrations } from "../src/db/migrate.js";

const reportPath =
  process.env["LOCAL_MEMORY_PERF_REPORT"] ?? join("/tmp", `local-memory-search-proof-${Date.now()}.md`);

const repoSizes = [
  { slug: "perf_small", count: Number(process.env["LOCAL_MEMORY_PERF_SMALL"] ?? 100) },
  { slug: "perf_medium", count: Number(process.env["LOCAL_MEMORY_PERF_MEDIUM"] ?? 2_000) },
  { slug: "perf_large", count: Number(process.env["LOCAL_MEMORY_PERF_LARGE"] ?? 20_000) },
] as const;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function vector(seed: number): string {
  const values: string[] = [];
  for (let i = 0; i < 256; i += 1) {
    const raw = ((seed * 1103515245 + i * 12345) % 2000) - 1000;
    values.push((raw / 10_000).toFixed(4));
  }
  return `[${values.join(",")}]`;
}

function time<T>(fn: () => T): { value: T; ms: number } {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
}

function seedRepo(slug: string, count: number): number {
  const db = getDb();
  return time(() => {
    db.transaction((tx) => {
      const repoId = randomUUID();
      tx.run(
        `INSERT INTO repositories (id, slug, name, root_path, root_hash, metadata)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [repoId, slug, slug, `/tmp/${slug}`, sha256(`/tmp/${slug}`), JSON.stringify({ identity_kind: "folder" })],
      );
      const repo = tx.get<{ pk: number }>("SELECT pk FROM repositories WHERE id = ?", [repoId]);
      if (!repo) throw new Error(`Failed to create ${slug}`);

      for (let i = 1; i <= count; i += 1) {
        const memoryId = randomUUID();
        const entityId = randomUUID();
        const content = `repo ${slug} common_alpha common_beta ${
          i % 101 === 0 ? "rare_needle" : "common_term"
        } ${i % 17 === 0 ? "truck semantic vector" : "memory search text"} ${i}`;
        tx.run(
          `INSERT INTO memories (
             id, repository_id, user_id, memory_type, content, summary, importance, created_by, source, updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            memoryId,
            repoId,
            "perf-user",
            ["fact", "decision", "procedure", "episode", "reference", "convention"][i % 6] ?? "fact",
            content,
            `summary ${slug} ${i}`,
            0.5 + ((i % 50) / 100),
            "perf",
            "seed",
            new Date(Date.now() - i * 1000).toISOString(),
          ],
        );
        const memory = tx.get<{ pk: number }>("SELECT pk FROM memories WHERE id = ?", [memoryId]);
        if (!memory) throw new Error(`Failed to create memory ${i}`);
        tx.run("INSERT INTO memory_vectors(memory_pk, repository_pk, embedding) VALUES (?, ?, ?)", [
          BigInt(memory.pk),
          BigInt(repo.pk),
          vector((i % 16) + 1),
        ]);
        tx.run("INSERT INTO memory_tags (memory_id, repository_id, tag) VALUES (?, ?, ?)", [
          memoryId,
          repoId,
          i % 2 === 0 ? "truck" : "note",
        ]);
        if (i <= Math.min(count, 10_000)) {
          const entityName = i % 97 === 0 ? `rare_entity_${slug}_${i}` : `common_entity_${slug}_${i}`;
          tx.run("INSERT INTO entities (id, repository_id, name, entity_type) VALUES (?, ?, ?, ?)", [
            entityId,
            repoId,
            entityName,
            ["service", "file", "package", "person", "concept", "api", "error", "env_var"][i % 8] ?? "concept",
          ]);
          tx.run("INSERT INTO memory_entities (memory_id, repository_id, entity_id, relevance) VALUES (?, ?, ?, ?)", [
            memoryId,
            repoId,
            entityId,
            1,
          ]);
        }
      }
    });
  }).ms;
}

function measure(title: string, fn: () => unknown): { title: string; ms: number; count: number } {
  const started = performance.now();
  const rows = fn();
  const count = Array.isArray(rows) ? rows.length : 1;
  return { title, ms: performance.now() - started, count };
}

async function main(): Promise<void> {
  const dir = join(tmpdir(), `local-memory-sqlite-proof-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const databasePath = join(dir, "proof.sqlite3");
  process.env["LOCAL_MEMORY_DB_PATH"] = databasePath;
  resetConfig();

  const report: string[] = ["# Local Memory Search Performance Proof", "", `Database: \`${databasePath}\``, ""];
  try {
    const migration = time(() => void runMigrations());
    report.push(`Migration time: \`${migration.ms.toFixed(0)} ms\``, "");

    report.push("## Seed", "", "| Repo | Memories | Seed time |", "|---|---:|---:|");
    for (const repo of repoSizes) {
      const seedMs = seedRepo(repo.slug, repo.count);
      report.push(`| \`${repo.slug}\` | ${repo.count} | ${seedMs.toFixed(0)} ms |`);
    }

    const db = getDb();
    const sample = vector(3);
    const measures: { title: string; ms: number; count: number }[] = [];
    for (const repo of repoSizes) {
      measures.push(
        measure(`${repo.slug}: list current repo`, () =>
          db.all(
            `SELECT m.id FROM memories m
             JOIN repositories r ON r.id = m.repository_id
             WHERE r.slug = ? AND m.deleted_at IS NULL AND m.valid_until IS NULL
             ORDER BY m.updated_at DESC LIMIT 20`,
            [repo.slug],
          ),
        ),
      );
      measures.push(
        measure(`${repo.slug}: tag search`, () =>
          db.all(
            `SELECT m.id FROM memories m
             JOIN repositories r ON r.id = m.repository_id
             WHERE r.slug = ? AND m.deleted_at IS NULL AND m.valid_until IS NULL
               AND EXISTS (
                 SELECT 1 FROM memory_tags mt
                 WHERE mt.memory_id = m.id AND mt.repository_id = m.repository_id AND mt.tag = 'truck'
               )
             ORDER BY m.updated_at DESC LIMIT 20`,
            [repo.slug],
          ),
        ),
      );
      measures.push(
        measure(`${repo.slug}: FTS common`, () =>
          db.all(
            `SELECT m.id
             FROM memories_fts
             JOIN memories m ON m.pk = memories_fts.rowid
             JOIN repositories r ON r.id = m.repository_id
             WHERE memories_fts MATCH 'common_alpha'
               AND r.slug = ?
               AND m.deleted_at IS NULL
               AND m.valid_until IS NULL
             ORDER BY bm25(memories_fts), m.updated_at DESC LIMIT 20`,
            [repo.slug],
          ),
        ),
      );
      measures.push(
        measure(`${repo.slug}: FTS rare`, () =>
          db.all(
            `SELECT m.id
             FROM memories_fts
             JOIN memories m ON m.pk = memories_fts.rowid
             JOIN repositories r ON r.id = m.repository_id
             WHERE memories_fts MATCH 'rare_needle'
               AND r.slug = ?
               AND m.deleted_at IS NULL
               AND m.valid_until IS NULL
             ORDER BY bm25(memories_fts), m.updated_at DESC LIMIT 20`,
            [repo.slug],
          ),
        ),
      );
      measures.push(
        measure(`${repo.slug}: semantic current`, () =>
          db.all(
            `WITH repo AS (SELECT pk FROM repositories WHERE slug = ?),
             ranked AS (
               SELECT memory_pk, distance
               FROM memory_vectors
               WHERE embedding MATCH ? AND k = 20 AND repository_pk = (SELECT pk FROM repo)
             )
             SELECT m.id
             FROM ranked
             JOIN memories m ON m.pk = ranked.memory_pk
             ORDER BY ranked.distance ASC`,
            [repo.slug, sample],
          ),
        ),
      );
      measures.push(
        measure(`${repo.slug}: entity search common`, () =>
          db.all(
            `SELECT e.id
             FROM entities_fts
             JOIN entities e ON e.pk = entities_fts.rowid
             JOIN repositories r ON r.id = e.repository_id
             WHERE r.slug = ? AND entities_fts.name LIKE '%common_entity%'
             LIMIT 20`,
            [repo.slug],
          ),
        ),
      );
    }
    measures.push(
      measure("all repos: semantic", () =>
        db.all(
          `SELECT memory_pk, distance
           FROM memory_vectors
           WHERE embedding MATCH ? AND k = 20
           ORDER BY distance ASC`,
          [sample],
        ),
      ),
    );

    report.push("", "## Summary", "", "| Query | Rows | Wall time |", "|---|---:|---:|");
    for (const item of measures) {
      report.push(`| ${item.title} | ${item.count} | ${item.ms.toFixed(1)} ms |`);
    }

    writeFileSync(reportPath, `${report.join("\n")}\n`);
    console.log(reportPath);
  } finally {
    await closeDb();
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

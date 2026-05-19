import postgres from "postgres";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const migrationsDir = join(root, "src", "db", "migrations");
const baseUrl = process.env["LOCAL_MEMORY_DATABASE_URL"] ?? "postgres://local_memory:local_memory@127.0.0.1:55432/local_memory";
const reportPath = process.env["LOCAL_MEMORY_PERF_REPORT"] ?? join("/tmp", `local-memory-search-proof-${Date.now()}.md`);

const repoSizes = [
  { slug: "perf_small", count: Number(process.env["LOCAL_MEMORY_PERF_SMALL"] ?? 100) },
  { slug: "perf_medium", count: Number(process.env["LOCAL_MEMORY_PERF_MEDIUM"] ?? 2_000) },
  { slug: "perf_large", count: Number(process.env["LOCAL_MEMORY_PERF_LARGE"] ?? 20_000) },
  { slug: "perf_extra_large", count: Number(process.env["LOCAL_MEMORY_PERF_EXTRA_LARGE"] ?? 100_000) },
] as const;

function dbName(): string {
  return `local_memory_perf_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}`;
}

function quoteIdent(value: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe identifier: ${value}`);
  }
  return `"${value}"`;
}

function databaseUrl(name: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function adminUrl(): string {
  const url = new URL(baseUrl);
  url.pathname = "/postgres";
  return url.toString();
}

function vector(seed: number): string {
  const values: string[] = [];
  for (let i = 0; i < 256; i += 1) {
    const raw = ((seed * 1103515245 + i * 12345) % 2000) - 1000;
    values.push((raw / 10_000).toFixed(4));
  }
  return `[${values.join(",")}]`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function vectorCase(alias = "gs"): string {
  const parts: string[] = ["CASE"];
  for (let i = 0; i < 16; i += 1) {
    parts.push(`WHEN (${alias} % 16) = ${i} THEN '${vector(i + 1)}'::vector`);
  }
  parts.push(`ELSE '${vector(99)}'::vector END`);
  return parts.join(" ");
}

async function applyMigrations(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `;
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), "utf-8");
    const stripped = content.replace(/^\s*BEGIN\s*;/im, "").replace(/\s*COMMIT\s*;\s*$/im, "");
    await sql.unsafe(stripped);
    await sql`INSERT INTO _migrations (name) VALUES (${file}) ON CONFLICT (name) DO NOTHING`;
  }
}

async function seedRepo(sql: postgres.Sql, slug: string, count: number): Promise<number> {
  const started = performance.now();
  const [repo] = await sql<{ id: string }[]>`
    INSERT INTO repositories (slug, name, root_path, root_hash, metadata)
    VALUES (
      ${slug},
      ${slug},
      ${`/tmp/${slug}`},
      ${sha256(`/tmp/${slug}`)},
      '{"identity_kind":"folder"}'::jsonb
    )
    RETURNING id::text
  `;
  if (!repo) throw new Error(`Failed to create ${slug}`);

  await sql.unsafe(`
    INSERT INTO memories (
      repository_id, user_id, memory_type, content, summary, embedding,
      importance, created_by, source, updated_at
    )
    SELECT
      '${repo.id}'::uuid,
      'perf-user',
      (ARRAY['fact','decision','procedure','episode','reference','convention'])[(gs % 6) + 1],
      'repo ${slug} common_alpha common_beta ' ||
        CASE WHEN gs % 101 = 0 THEN 'rare_needle ' ELSE 'common_term ' END ||
        CASE WHEN gs % 17 = 0 THEN 'truck semantic vector ' ELSE 'memory search text ' END ||
        gs::text,
      'summary ${slug} ' || gs::text,
      ${vectorCase("gs")},
      0.5 + ((gs % 50)::float / 100),
      'perf',
      'seed',
      now() - (gs || ' seconds')::interval
    FROM generate_series(1, ${count}) AS gs
  `);

  await sql.unsafe(`
    INSERT INTO memory_tags (memory_id, repository_id, tag)
    SELECT id, repository_id, CASE WHEN abs(('x' || substr(md5(id::text), 1, 8))::bit(32)::int) % 2 = 0 THEN 'truck' ELSE 'note' END
    FROM memories WHERE repository_id = '${repo.id}'::uuid
  `);

  await sql.unsafe(`
    INSERT INTO entities (repository_id, name, entity_type)
    SELECT '${repo.id}'::uuid, 'api_' || gs::text, 'api'
    FROM generate_series(1, 50) AS gs
  `);

  await sql.unsafe(`
    WITH mem AS (
      SELECT id, repository_id, row_number() OVER (ORDER BY updated_at DESC) AS rn
      FROM memories
      WHERE repository_id = '${repo.id}'::uuid
      LIMIT 1000
    ),
    ent AS (
      SELECT id, row_number() OVER (ORDER BY name) AS rn
      FROM entities
      WHERE repository_id = '${repo.id}'::uuid
    )
    INSERT INTO memory_entities (memory_id, repository_id, entity_id, relevance)
    SELECT mem.id, mem.repository_id, ent.id, 1.0
    FROM mem
    JOIN ent ON ((mem.rn - 1) % 50) = (ent.rn - 1)
  `);

  return performance.now() - started;
}

async function explain(sql: postgres.Sql, title: string, query: string): Promise<{ title: string; timeMs: number; plan: string }> {
  const started = performance.now();
  const rows = await sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${query}`);
  const elapsed = performance.now() - started;
  const plan = rows.map((row) => String(row["QUERY PLAN"])).join("\n");
  return { title, timeMs: elapsed, plan };
}

function executionTime(plan: string): string {
  return /Execution Time: ([0-9.]+ ms)/.exec(plan)?.[1] ?? "unknown";
}

function planHeadline(plan: string): string {
  const lines = plan.split("\n").filter((line) => /Scan|Sort|Limit|Bitmap|Index/.test(line));
  return lines.slice(0, 4).map((line) => line.trim()).join("; ");
}

async function main(): Promise<void> {
  const name = dbName();
  const admin = postgres(adminUrl(), { max: 1, ssl: false });
  await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE ${quoteIdent(name)}`);
  await admin.end();

  const sql = postgres(databaseUrl(name), {
    max: 4,
    ssl: false,
    idle_timeout: 30,
    connect_timeout: 10,
    connection: { "hnsw.ef_search": "100" },
  });

  const report: string[] = [`# Local Memory Search Performance Proof`, "", `Database: \`${name}\``, ""];
  try {
    const migrationStart = performance.now();
    await applyMigrations(sql);
    report.push(`Migration time: \`${(performance.now() - migrationStart).toFixed(0)} ms\``, "");

    report.push("## Seed", "", "| Repo | Memories | Seed time |", "|---|---:|---:|");
    for (const repo of repoSizes) {
      const seedTime = await seedRepo(sql, repo.slug, repo.count);
      report.push(`| \`${repo.slug}\` | ${repo.count} | ${seedTime.toFixed(0)} ms |`);
    }

    const reindexStart = performance.now();
    await sql`REINDEX INDEX idx_memories_embedding`;
    report.push("", `HNSW reindex time: \`${(performance.now() - reindexStart).toFixed(0)} ms\``, "");

    const analyzeStart = performance.now();
    await sql`ANALYZE repositories`;
    await sql`ANALYZE memories`;
    await sql`ANALYZE memory_tags`;
    report.push(`Analyze time: \`${(performance.now() - analyzeStart).toFixed(0)} ms\``, "");

    const [sizes] = await sql<{ table_size: string; total_size: string; hnsw_size: string }[]>`
      SELECT
        pg_size_pretty(pg_relation_size('memories')) AS table_size,
        pg_size_pretty(pg_total_relation_size('memories')) AS total_size,
        pg_size_pretty(pg_relation_size('idx_memories_embedding')) AS hnsw_size
    `;
    if (sizes) {
      report.push("## Sizes", "", "| Metric | Value |", "|---|---:|");
      report.push(`| memories table | ${sizes.table_size} |`);
      report.push(`| memories total | ${sizes.total_size} |`);
      report.push(`| HNSW index | ${sizes.hnsw_size} |`, "");
    }

    const [sample] = await sql<{ embedding: string }[]>`SELECT embedding::text FROM memories LIMIT 1`;
    if (!sample) throw new Error("No sample embedding after seed");

    const plans: { title: string; timeMs: number; plan: string }[] = [];
    for (const repo of repoSizes) {
      plans.push(
        await explain(
          sql,
          `${repo.slug}: list current repo`,
          `SELECT id FROM memories WHERE repository_id = (SELECT id FROM repositories WHERE slug='${repo.slug}')
             AND deleted_at IS NULL AND valid_until IS NULL
           ORDER BY updated_at DESC LIMIT 20`,
        ),
      );
      plans.push(
        await explain(
          sql,
          `${repo.slug}: tag search`,
          `SELECT m.id FROM memories m
           WHERE m.repository_id = (SELECT id FROM repositories WHERE slug='${repo.slug}')
             AND m.deleted_at IS NULL AND m.valid_until IS NULL
             AND EXISTS (
               SELECT 1 FROM memory_tags mt
               WHERE mt.memory_id = m.id AND mt.repository_id = m.repository_id AND mt.tag = 'truck'
             )
           ORDER BY m.updated_at DESC LIMIT 20`,
        ),
      );
      plans.push(
        await explain(
          sql,
          `${repo.slug}: FTS common`,
          `SELECT id FROM memories
           WHERE repository_id = (SELECT id FROM repositories WHERE slug='${repo.slug}')
             AND deleted_at IS NULL AND valid_until IS NULL
             AND fts_vector @@ plainto_tsquery('english', 'common_alpha')
           ORDER BY ts_rank(fts_vector, plainto_tsquery('english', 'common_alpha')) DESC, updated_at DESC
           LIMIT 20`,
        ),
      );
      plans.push(
        await explain(
          sql,
          `${repo.slug}: FTS rare`,
          `SELECT id FROM memories
           WHERE repository_id = (SELECT id FROM repositories WHERE slug='${repo.slug}')
             AND deleted_at IS NULL AND valid_until IS NULL
             AND fts_vector @@ plainto_tsquery('english', 'rare_needle')
           ORDER BY ts_rank(fts_vector, plainto_tsquery('english', 'rare_needle')) DESC, updated_at DESC
           LIMIT 20`,
        ),
      );
      plans.push(
        await explain(
          sql,
          `${repo.slug}: semantic current exact`,
          `WITH repo_candidates AS MATERIALIZED (
             SELECT id, repository_id, embedding
             FROM memories
             WHERE repository_id = (SELECT id FROM repositories WHERE slug='${repo.slug}')
               AND deleted_at IS NULL AND valid_until IS NULL AND embedding IS NOT NULL
           ),
           ranked AS (
             SELECT id, repository_id
             FROM repo_candidates
             ORDER BY embedding <=> '${sample.embedding}'::vector
             LIMIT 20
           )
           SELECT m.id
           FROM ranked
           JOIN memories m ON m.id = ranked.id AND m.repository_id = ranked.repository_id`,
        ),
      );
    }
    plans.push(
      await explain(
        sql,
        "all repos: semantic",
        `SELECT id FROM memories
         WHERE deleted_at IS NULL AND valid_until IS NULL AND embedding IS NOT NULL
         ORDER BY embedding <=> '${sample.embedding}'::vector
         LIMIT 20`,
      ),
    );

    report.push("## Summary", "", "| Query | Wall time | DB execution | Plan headline |", "|---|---:|---:|---|");
    for (const plan of plans) {
      report.push(`| ${plan.title} | ${plan.timeMs.toFixed(0)} ms | ${executionTime(plan.plan)} | ${planHeadline(plan.plan)} |`);
    }

    report.push("", "## Plans", "");
    for (const plan of plans) {
      report.push(`### ${plan.title}`, "", "```text", plan.plan, "```", "");
    }
    writeFileSync(reportPath, `${report.join("\n")}\n`);
    console.log(reportPath);
  } finally {
    await sql.end({ timeout: 5 });
    const cleanup = postgres(adminUrl(), { max: 1, ssl: false });
    await cleanup.unsafe(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
    await cleanup.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});

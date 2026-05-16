import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "./connection.js";
import { logger } from "../services/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  const sql = getDb();

  // Disable statement timeout for migrations — DDL and advisory locks can take
  // longer than the 30s runtime query timeout, especially under contention.
  await sql`SET statement_timeout = 0`;

  // Create migrations tracking table
  await sql`
    CREATE TABLE IF NOT EXISTS _migrations (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  // Acquire advisory lock to prevent concurrent migration runs.
  // Use lock_timeout to fail fast if a stale lock is held by a crashed pod,
  // rather than blocking indefinitely.
  await sql`SET lock_timeout = '60000'`;
  await sql`SELECT pg_advisory_lock(42)`;
  try {
    // Safety check: detect stale or inconsistent migration tracking.
    // Case 1: Neither core table exists but migrations are recorded → stale, reset.
    // Case 2: 'memories' exists (post-004 rename) but some migrations aren't recorded
    //         → record them so we don't try to re-run on a renamed table.
    const tableCheck = await sql`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = current_schema() AND table_name = 'knowledge_entries') AS "hasKe",
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema = current_schema() AND table_name = 'memories') AS "hasMem"
    `;
    const { hasKe, hasMem } = tableCheck[0] as {
      hasKe: boolean;
      hasMem: boolean;
    };

    if (!hasKe && !hasMem) {
      // Neither core table exists — any tracked migrations are stale
      const tracked = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM _migrations`;
      if (Number(tracked[0]?.count) > 0) {
        logger.info("Stale migration tracking detected — resetting _migrations");
        await sql`TRUNCATE _migrations`;
      }
    } else if (hasMem && !hasKe) {
      // Table was already renamed to 'memories' (post-004 state).
      // Ensure migrations 001–004 are recorded so they aren't re-applied.
      const result = await sql<{ name: string }[]>`
        SELECT name FROM _migrations WHERE name IN (
          '001_initial_schema.sql', '002_pgvector.sql',
          '003_fts_indexes.sql', '004_memories.sql'
        )
      `;
      const recorded = new Set(result.map((r) => r.name));
      const expected = ["001_initial_schema.sql", "002_pgvector.sql", "003_fts_indexes.sql", "004_memories.sql"];
      for (const m of expected) {
        if (!recorded.has(m)) {
          logger.info(`Recording previously-applied migration: ${m}`);
          await sql`INSERT INTO _migrations (name) VALUES (${m}) ON CONFLICT (name) DO NOTHING`;
        }
      }
    }
    const migrationsDir = join(__dirname, "migrations");
    let files: string[];
    try {
      files = readdirSync(migrationsDir)
        .filter((f) => f.endsWith(".sql"))
        .sort();
    } catch {
      logger.error(`No migrations directory found at ${migrationsDir}`);
      return;
    }

    const applied = await sql<{ name: string }[]>`SELECT name FROM _migrations`;
    const appliedSet = new Set(applied.map((r) => r.name));

    for (const file of files) {
      if (appliedSet.has(file)) continue;

      logger.info(`Applying migration: ${file}`);
      const content = readFileSync(join(migrationsDir, file), "utf-8");
      // Strip BEGIN/COMMIT from SQL — the driver manages the transaction
      const stripped = content.replace(/^\s*BEGIN\s*;/im, "").replace(/\s*COMMIT\s*;\s*$/im, "");

      // Migrations with @no-transaction (e.g. CONCURRENTLY indexes) run outside a transaction.
      // Record optimistically before running so a crash after migration but before INSERT
      // doesn't cause a re-run (CONCURRENTLY + IF NOT EXISTS is safe but other DDL may not be).
      if (content.includes("@no-transaction")) {
        await sql.unsafe("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        try {
          // Run each statement individually — postgres.js wraps multi-statement
          // sql.unsafe() calls in an implicit transaction, which breaks CONCURRENTLY.
          const statements = stripped
            .split(/;\s*\n/)
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          for (const stmt of statements) {
            await sql.unsafe(stmt);
          }
        } catch (err) {
          await sql.unsafe("DELETE FROM _migrations WHERE name = $1", [file]).catch(() => {});
          throw err;
        }
      } else {
        await sql.begin(async (tx) => {
          await tx.unsafe(stripped);
          await tx.unsafe("INSERT INTO _migrations (name) VALUES ($1)", [file]);
        });
      }
      logger.info(`Applied: ${file}`);
    }

    logger.info("All migrations applied.");
  } finally {
    await sql`SELECT pg_advisory_unlock(42)`;
    // Restore runtime statement timeout after migrations
    await sql`SET statement_timeout = '30000'`;
  }
}

// Run directly if called as a script
const isMain = process.argv[1] && (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));

if (isMain) {
  runMigrations()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err: unknown) => {
      console.error("Migration failed:", err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}

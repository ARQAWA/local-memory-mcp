import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "./connection.js";
import { logger } from "../services/logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function applyMigration(sql: ReturnType<typeof getDb>, file: string, content: string): Promise<void> {
  logger.info(`Applying migration: ${file}`);
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
    const pending = files
      .filter((file) => !appliedSet.has(file))
      .map((file) => ({
        file,
        content: readFileSync(join(migrationsDir, file), "utf-8"),
      }));
    for (const migration of pending) {
      await applyMigration(sql, migration.file, migration.content);
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

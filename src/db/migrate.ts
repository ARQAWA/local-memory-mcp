import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getDb, closeDb } from "./connection.js";
import { logger } from "../services/logger.js";
import { loadConfig } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function applyMigration(file: string, content: string): void {
  const db = getDb();
  logger.info(`Applying migration: ${file}`);
  db.transaction((tx) => {
    tx.exec(content);
    tx.run("INSERT INTO _migrations (name) VALUES (?)", [file]);
  });
  logger.info(`Applied: ${file}`);
}

function backupDatabaseBeforeMigrations(pendingFiles: string[]): string | null {
  if (pendingFiles.length === 0) return null;

  const { databasePath } = loadConfig();
  if (databasePath === ":memory:") return null;

  const backupDir = join(dirname(databasePath), "backups");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = join(backupDir, `local-memory-before-${pendingFiles[0]}-${stamp}.sqlite3`);
  mkdirSync(backupDir, { recursive: true });
  getDb().run("VACUUM INTO ?", [backupPath]);
  logger.info(`SQLite backup created before migrations: ${backupPath}`);
  return backupPath;
}

export function runMigrations(): Promise<void> {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);

  const migrationsDir = join(__dirname, "migrations");
  let files: string[];
  try {
    files = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .sort();
  } catch {
    logger.error(`No migrations directory found at ${migrationsDir}`);
    return Promise.resolve();
  }

  const applied = db.all<{ name: string }>("SELECT name FROM _migrations");
  const appliedSet = new Set(applied.map((row) => row.name));
  const pendingFiles = files.filter((file) => !appliedSet.has(file));
  backupDatabaseBeforeMigrations(pendingFiles);

  for (const file of pendingFiles) {
    if (appliedSet.has(file)) continue;
    applyMigration(file, readFileSync(join(migrationsDir, file), "utf-8"));
  }

  logger.info("All migrations applied.");
  return Promise.resolve();
}

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

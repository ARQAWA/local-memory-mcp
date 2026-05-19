import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { load as loadSqliteVec } from "sqlite-vec";
import { loadConfig } from "../config.js";
import { DatabaseError } from "../errors.js";

type SqlParam = string | number | bigint | Buffer | null;
type SqlParams = SqlParam[];

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export class LocalDatabase {
  private readonly db: DatabaseSync;
  private inTransaction = false;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): StatementSync {
    return this.db.prepare(sql);
  }

  all<T>(sql: string, params: SqlParams = []): T[] {
    return this.prepare(sql).all(...params) as T[];
  }

  get<T>(sql: string, params: SqlParams = []): T | undefined {
    return this.prepare(sql).get(...params) as T | undefined;
  }

  run(sql: string, params: SqlParams = []): RunResult {
    const result = this.prepare(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  }

  transaction<T>(fn: (tx: LocalDatabase) => T): T {
    if (this.inTransaction) return fn(this);
    this.inTransaction = true;
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(this);
      this.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.exec("ROLLBACK");
      } finally {
        this.inTransaction = false;
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  async transactionAsync<T>(fn: (tx: LocalDatabase) => Promise<T>): Promise<T> {
    if (this.inTransaction) return fn(this);
    this.inTransaction = true;
    this.exec("BEGIN IMMEDIATE");
    try {
      const result = await fn(this);
      this.exec("COMMIT");
      return result;
    } catch (err) {
      try {
        this.exec("ROLLBACK");
      } finally {
        this.inTransaction = false;
      }
      throw err;
    } finally {
      this.inTransaction = false;
    }
  }

  close(): void {
    this.db.close();
  }
}

let database: LocalDatabase | null = null;

export function getDb(): LocalDatabase {
  if (database) return database;

  const config = loadConfig();
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const raw = new DatabaseSync(config.databasePath, { allowExtension: true });
  if (config.sqliteExtensionPath) {
    raw.loadExtension(config.sqliteExtensionPath);
  } else {
    loadSqliteVec(raw);
  }
  raw.enableLoadExtension(false);
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA busy_timeout = 5000");

  database = new LocalDatabase(raw);
  return database;
}

export function withTransaction<T>(fn: (txSql: ReturnType<typeof getDb>) => Promise<T>): Promise<T> {
  const db = getDb();
  return db.transactionAsync(() => fn(db));
}

export function closeDb(): Promise<void> {
  if (database) {
    database.close();
    database = null;
  }
  return Promise.resolve();
}

export function asDatabaseError(label: string, err: unknown): DatabaseError {
  return new DatabaseError(label, err instanceof Error ? err : undefined);
}

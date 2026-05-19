import postgres from "postgres";
import { loadConfig } from "../config.js";
import { DatabaseError } from "../errors.js";

let sql: postgres.Sql | null = null;

export function getDb(): postgres.Sql {
  if (sql) return sql;

  const config = loadConfig();
  if (!config.databaseUrl) {
    throw new DatabaseError("LOCAL_MEMORY_DATABASE_URL or DATABASE_URL is required");
  }

  sql = postgres(config.databaseUrl, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    max_lifetime: 300,
    ssl: false,
    types: {
      bigint: postgres.BigInt,
    },
    onnotice: () => {},
    connection: {
      "hnsw.ef_search": "100",
      statement_timeout: 30000,
    },
  });

  tryEnablePgvectorTuning(sql).catch(() => {});
  return sql;
}

async function tryEnablePgvectorTuning(db: postgres.Sql): Promise<void> {
  try {
    await db`SET hnsw.iterative_scan = 'relaxed_order'`;
  } catch {
    // pgvector < 0.7 does not support this setting.
  }
}

interface Transactable {
  begin<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}

export async function withTransaction<T>(fn: (txSql: ReturnType<typeof getDb>) => Promise<T>): Promise<T> {
  const db = getDb();
  return (db as unknown as Transactable).begin((txSql) => fn(txSql as ReturnType<typeof getDb>));
}

export async function closeDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

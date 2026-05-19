import { getDb } from "../db/connection.js";
import { dbQuery } from "../errors.js";
import type { SqlProvider } from "./memory.repository.js";

export interface AuditEntry {
  id: string;
  repository_id: string;
  memory_id: string | null;
  action: string;
  actor: string;
  changes: Record<string, unknown> | null;
  created_at: Date;
}

function parseChanges(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizeAuditRows(rows: AuditEntry[]): AuditEntry[] {
  return rows.map((r) => ({ ...r, changes: parseChanges(r.changes) }));
}

export class AuditRepository {
  private getSql: SqlProvider;

  constructor(sqlProvider?: SqlProvider) {
    this.getSql = sqlProvider ?? getDb;
  }

  withSql(sqlProvider: SqlProvider): AuditRepository {
    return new AuditRepository(sqlProvider);
  }

  async log(data: {
    repository_id: string;
    memory_id: string;
    action: "create" | "update" | "delete" | "restore";
    actor: string;
    changes?: Record<string, unknown>;
  }): Promise<void> {
    return dbQuery("AuditRepository.log", async () => {
      const sql = this.getSql();
      const changesJson = data.changes ? JSON.stringify(data.changes) : null;
      await sql`
        INSERT INTO audit_log (id, repository_id, memory_id, action, actor, changes)
        VALUES (
          gen_random_uuid(),
          ${data.repository_id},
          ${data.memory_id},
          ${data.action},
          ${data.actor},
          ${changesJson}::jsonb
        )
      `;
    });
  }

  async getRecent(limit = 50, repositoryId?: string): Promise<AuditEntry[]> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`WHERE repository_id = ${repositoryId}` : sql``;
    const rows = await sql<AuditEntry[]>`
      SELECT * FROM audit_log
      ${repositoryFilter}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return normalizeAuditRows(rows);
  }
}

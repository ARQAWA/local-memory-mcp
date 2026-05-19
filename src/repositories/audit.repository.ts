import { randomUUID } from "node:crypto";
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

interface AuditRow extends Omit<AuditEntry, "changes" | "created_at"> {
  changes: string | null;
  created_at: string;
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

function normalizeAuditRows(rows: AuditRow[]): AuditEntry[] {
  return rows.map((row) => ({ ...row, changes: parseChanges(row.changes), created_at: new Date(row.created_at) }));
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
      this.getSql().run(
        `INSERT INTO audit_log (id, repository_id, memory_id, action, actor, changes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(),
          data.repository_id,
          data.memory_id,
          data.action,
          data.actor,
          data.changes ? JSON.stringify(data.changes) : null,
        ],
      );
    });
  }

  async getRecent(limit = 50, repositoryId?: string): Promise<AuditEntry[]> {
    const rows = this.getSql().all<AuditRow>(
      `SELECT * FROM audit_log
       ${repositoryId ? "WHERE repository_id = ?" : ""}
       ORDER BY created_at DESC
       LIMIT ?`,
      repositoryId ? [repositoryId, limit] : [limit],
    );
    return normalizeAuditRows(rows);
  }
}

import { getDb } from "../db/connection.js";
import { dbQuery } from "../errors.js";
import type { SqlProvider } from "./memory.repository.js";

export interface AuditEntry {
  id: string;
  memory_id: string | null;
  action: string;
  actor: string;
  changes: Record<string, unknown> | null;
  created_at: Date;
}

/** Parse changes from DB — may be a JSON string (SQLite) or already an object (PG jsonb). */
function parseChanges(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
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
    entry_id: string;
    action: "create" | "update" | "delete" | "restore";
    actor: string;
    changes?: Record<string, unknown>;
    org_id?: string;
  }): Promise<void> {
    return dbQuery("AuditRepository.log", async () => {
      const sql = this.getSql();
      // Verify memory belongs to the expected org before inserting audit entry
      if (data.org_id) {
        const [mem] = await sql<{ id: string }[]>`
          SELECT id FROM memories WHERE id = ${data.entry_id} AND org_id = ${data.org_id}
        `;
        if (!mem) return; // Memory doesn't belong to this org — skip audit
      }
      const changesJson = data.changes ? JSON.stringify(data.changes) : null;
      await sql`
      INSERT INTO audit_log (id, memory_id, action, actor, changes)
      VALUES (gen_random_uuid(), ${data.entry_id}, ${data.action}, ${data.actor}, ${changesJson}::jsonb)
    `;
    });
  }

  async getByEntry(entryId: string, orgId?: string): Promise<AuditEntry[]> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND m.org_id = ${orgId}` : sql``;
    const rows = await sql<AuditEntry[]>`
      SELECT al.* FROM audit_log al
      JOIN memories m ON m.id = al.memory_id
      WHERE al.memory_id = ${entryId} ${orgFilter}
      ORDER BY al.created_at DESC
    `;
    return normalizeAuditRows(rows);
  }

  async getRecent(limit = 50, teamSlug?: string, orgId?: string): Promise<AuditEntry[]> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND m.org_id = ${orgId}` : sql``;
    if (teamSlug) {
      const rows = await sql<AuditEntry[]>`
        SELECT al.* FROM audit_log al
        JOIN memories m ON m.id = al.memory_id
        JOIN teams t ON t.id = m.team_id AND t.slug = ${teamSlug}
        WHERE TRUE ${orgFilter}
        ORDER BY al.created_at DESC LIMIT ${limit}
      `;
      return normalizeAuditRows(rows);
    }
    const rows = await sql<AuditEntry[]>`
      SELECT al.* FROM audit_log al
      JOIN memories m ON m.id = al.memory_id
      WHERE TRUE ${orgFilter}
      ORDER BY al.created_at DESC LIMIT ${limit}
    `;
    return normalizeAuditRows(rows);
  }
}

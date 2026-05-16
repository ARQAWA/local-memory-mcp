import { getDb } from "../db/connection.js";
import type { SqlProvider } from "./memory.repository.js";
import type { RelationType } from "../types/memory.js";
import { DatabaseError, dbQuery } from "../errors.js";

export interface EntryRelation {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: RelationType;
  description: string | null;
  created_at: Date;
}

export interface EntryRelationWithContext extends EntryRelation {
  source_summary: string;
  source_type: string;
  target_summary: string;
  target_type: string;
}

export class RelationRepository {
  private getSql: SqlProvider;

  constructor(sqlProvider?: SqlProvider) {
    this.getSql = sqlProvider ?? getDb;
  }

  withSql(sqlProvider: SqlProvider): RelationRepository {
    return new RelationRepository(sqlProvider);
  }

  async create(
    data: {
      source_id: string;
      target_id: string;
      relation_type: RelationType;
      description?: string | undefined;
    },
    orgId?: string,
  ): Promise<EntryRelation> {
    return dbQuery("RelationRepository.create", async () => {
      const sql = this.getSql();
      // Self-link guard
      if (data.source_id === data.target_id) {
        throw new DatabaseError("Cannot create relation: source and target are the same memory");
      }
      // Verify both memories belong to the same org before creating relation
      if (orgId) {
        const [ownership] = await sql<{ cnt: number }[]>`
        SELECT COUNT(*)::int AS cnt FROM memories
        WHERE id IN (${data.source_id}, ${data.target_id})
          AND org_id = ${orgId}
          AND deleted_at IS NULL
      `;
        if ((ownership?.cnt ?? 0) < 2) {
          throw new DatabaseError("Cannot create relation: one or both memories do not belong to this organization");
        }
      }
      const [row] = await sql<EntryRelation[]>`
      INSERT INTO memory_relations (id, source_memory_id, target_memory_id, relation_type, description)
      VALUES (gen_random_uuid(), ${data.source_id}, ${data.target_id}, ${data.relation_type}, ${data.description ?? null})
      RETURNING id, source_memory_id AS source_id, target_memory_id AS target_id, relation_type, description, created_at
    `;
      if (!row) throw new DatabaseError("INSERT INTO memory_relations did not return a row");
      return row;
    });
  }

  async findByEntry(
    entryId: string,
    orgId?: string,
    options?: { activeOnly?: boolean },
  ): Promise<EntryRelationWithContext[]> {
    return dbQuery(`RelationRepository.findByEntry(${entryId})`, async () => {
      const sql = this.getSql();
      const orgFilter = orgId ? sql`AND src.org_id = ${orgId} AND tgt.org_id = ${orgId}` : sql``;
      const activeFilter =
        options?.activeOnly !== false ? sql`AND src.valid_until IS NULL AND tgt.valid_until IS NULL` : sql``;
      return sql<EntryRelationWithContext[]>`
      SELECT mr.id, mr.source_memory_id AS source_id, mr.target_memory_id AS target_id,
        mr.relation_type, mr.description, mr.created_at,
        src.summary AS source_summary, src.memory_type AS source_type,
        tgt.summary AS target_summary, tgt.memory_type AS target_type
      FROM memory_relations mr
      JOIN memories src ON src.id = mr.source_memory_id
      JOIN memories tgt ON tgt.id = mr.target_memory_id
      WHERE (mr.source_memory_id = ${entryId} OR mr.target_memory_id = ${entryId})
        AND src.deleted_at IS NULL AND tgt.deleted_at IS NULL
        ${activeFilter}
        ${orgFilter}
      ORDER BY mr.created_at DESC
    `;
    });
  }

  async delete(sourceId: string, targetId: string, relationType: RelationType, orgId?: string): Promise<boolean> {
    const sql = this.getSql();
    const orgCheck = orgId
      ? sql`AND EXISTS (SELECT 1 FROM memories WHERE id = memory_relations.source_memory_id AND org_id = ${orgId})
        AND EXISTS (SELECT 1 FROM memories WHERE id = memory_relations.target_memory_id AND org_id = ${orgId})`
      : sql``;
    const [row] = await sql`
      DELETE FROM memory_relations
      WHERE source_memory_id = ${sourceId}
        AND target_memory_id = ${targetId}
        AND relation_type = ${relationType}
        ${orgCheck}
      RETURNING id
    `;
    return !!row;
  }

  async deleteById(id: string, orgId?: string): Promise<boolean> {
    const sql = this.getSql();
    const orgCheck = orgId
      ? sql`AND EXISTS (SELECT 1 FROM memories WHERE id = memory_relations.source_memory_id AND org_id = ${orgId})
        AND EXISTS (SELECT 1 FROM memories WHERE id = memory_relations.target_memory_id AND org_id = ${orgId})`
      : sql``;
    const [row] = await sql`
      DELETE FROM memory_relations WHERE id = ${id} ${orgCheck} RETURNING id
    `;
    return !!row;
  }
}

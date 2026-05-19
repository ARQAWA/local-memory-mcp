import { getDb } from "../db/connection.js";
import { DatabaseError, dbQuery } from "../errors.js";
import type { RelationType } from "../types/memory.js";
import type { SqlProvider } from "./memory.repository.js";

export interface EntryRelation {
  id: string;
  repository_id: string;
  source_id: string;
  target_id: string;
  relation_type: RelationType;
  description: string | null;
  origin: string;
  confidence: number;
  metadata: Record<string, string | number | boolean | null>;
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

  async create(data: {
    repository_id: string;
    source_id: string;
    target_id: string;
    relation_type: RelationType;
    description?: string | undefined;
    origin?: "manual" | "lineage" | "derived" | undefined;
    confidence?: number | undefined;
    metadata?: Record<string, string | number | boolean | null> | undefined;
    requireActiveEndpoints?: boolean | undefined;
  }): Promise<EntryRelation> {
    return dbQuery("RelationRepository.create", async () => {
      const sql = this.getSql();
      if (data.source_id === data.target_id) {
        throw new DatabaseError("Cannot create relation: source and target are the same memory");
      }
      const activeFilter = data.requireActiveEndpoints === false ? sql`` : sql`AND valid_until IS NULL`;
      const [ownership] = await sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count
        FROM memories
        WHERE id IN (${data.source_id}, ${data.target_id})
          AND repository_id = ${data.repository_id}
          AND deleted_at IS NULL
          ${activeFilter}
      `;
      if ((ownership?.count ?? 0) < 2) {
        throw new DatabaseError("Cannot create relation: both memories must belong to the same repository");
      }
      const [row] = await sql<EntryRelation[]>`
        INSERT INTO memory_relations (
          id, repository_id, source_memory_id, target_memory_id, relation_type, description,
          origin, confidence, metadata
        )
        VALUES (
          gen_random_uuid(),
          ${data.repository_id},
          ${data.source_id},
          ${data.target_id},
          ${data.relation_type},
          ${data.description ?? null},
          ${data.origin ?? "manual"},
          ${data.confidence ?? 1},
          ${sql.json(data.metadata ?? {})}::jsonb
        )
        ON CONFLICT (repository_id, source_memory_id, target_memory_id, relation_type)
        DO UPDATE SET
          description = EXCLUDED.description,
          origin = EXCLUDED.origin,
          confidence = EXCLUDED.confidence,
          metadata = EXCLUDED.metadata
        RETURNING id, repository_id, source_memory_id AS source_id, target_memory_id AS target_id,
          relation_type, description, origin, confidence, metadata, created_at
      `;
      if (!row) throw new DatabaseError("INSERT INTO memory_relations did not return a row");
      return row;
    });
  }

  async findByEntry(
    entryId: string,
    repositoryId?: string,
    options?: { activeOnly?: boolean; includeLineage?: boolean },
  ): Promise<EntryRelationWithContext[]> {
    return this.findByEntries([entryId], repositoryId, options);
  }

  async findByEntries(
    entryIds: string[],
    repositoryId?: string,
    options?: { activeOnly?: boolean; includeLineage?: boolean },
  ): Promise<EntryRelationWithContext[]> {
    if (entryIds.length === 0) return [];
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND mr.repository_id = ${repositoryId}` : sql``;
    const activeFilter =
      options?.activeOnly === false
        ? sql``
        : options?.includeLineage
          ? sql`AND (
              (src.valid_until IS NULL AND tgt.valid_until IS NULL
                AND (src.expires_at IS NULL OR src.expires_at > now())
                AND (tgt.expires_at IS NULL OR tgt.expires_at > now()))
              OR mr.relation_type = 'supersedes'
            )`
          : sql`AND src.valid_until IS NULL AND tgt.valid_until IS NULL
              AND (src.expires_at IS NULL OR src.expires_at > now())
              AND (tgt.expires_at IS NULL OR tgt.expires_at > now())`;
    return sql<EntryRelationWithContext[]>`
      WITH incidents AS (
        SELECT mr.*
        FROM memory_relations mr
        WHERE mr.source_memory_id = ANY(${entryIds}) ${repositoryFilter}
        UNION ALL
        SELECT mr.*
        FROM memory_relations mr
        WHERE mr.target_memory_id = ANY(${entryIds}) ${repositoryFilter}
      ),
      deduped AS (
        SELECT DISTINCT ON (id) *
        FROM incidents
        ORDER BY id, created_at DESC
      )
      SELECT mr.id, mr.repository_id, mr.source_memory_id AS source_id, mr.target_memory_id AS target_id,
        mr.relation_type, mr.description, mr.origin, mr.confidence, mr.metadata, mr.created_at,
        src.summary AS source_summary, src.memory_type AS source_type,
        tgt.summary AS target_summary, tgt.memory_type AS target_type
      FROM deduped mr
      JOIN memories src ON src.id = mr.source_memory_id
      JOIN memories tgt ON tgt.id = mr.target_memory_id
      WHERE src.deleted_at IS NULL
        AND tgt.deleted_at IS NULL
        ${activeFilter}
      ORDER BY mr.created_at DESC
    `;
  }

  async delete(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    repositoryId?: string,
  ): Promise<boolean> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
    const [row] = await sql`
      DELETE FROM memory_relations
      WHERE source_memory_id = ${sourceId}
        AND target_memory_id = ${targetId}
        AND relation_type = ${relationType}
        ${repositoryFilter}
      RETURNING id
    `;
    return !!row;
  }

  async deleteById(id: string, repositoryId?: string): Promise<boolean> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
    const [row] = await sql`
      DELETE FROM memory_relations WHERE id = ${id} ${repositoryFilter} RETURNING id
    `;
    return !!row;
  }
}

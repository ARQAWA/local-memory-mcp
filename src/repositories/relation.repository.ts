import { randomUUID } from "node:crypto";
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

interface RelationRow extends Omit<EntryRelationWithContext, "metadata" | "created_at"> {
  metadata: string | null;
  created_at: string;
}

function parseMetadata(raw: string | null): Record<string, string | number | boolean | null> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string | number | boolean | null>)
      : {};
  } catch {
    return {};
  }
}

function toRelation<T extends RelationRow>(row: T): T & EntryRelationWithContext {
  return { ...row, metadata: parseMetadata(row.metadata), created_at: new Date(row.created_at) };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
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
      const db = this.getSql();
      if (data.source_id === data.target_id) {
        throw new DatabaseError("Cannot create relation: source and target are the same memory");
      }
      const activeFilter = data.requireActiveEndpoints === false ? "" : "AND valid_until IS NULL";
      const ownership = db.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM memories
         WHERE id IN (?, ?)
           AND repository_id = ?
           AND deleted_at IS NULL
           ${activeFilter}`,
        [data.source_id, data.target_id, data.repository_id],
      );
      if ((ownership?.count ?? 0) < 2) {
        throw new DatabaseError("Cannot create relation: both memories must belong to the same repository");
      }
      const id = randomUUID();
      db.run(
        `INSERT INTO memory_relations (
           id, repository_id, source_memory_id, target_memory_id, relation_type, description,
           origin, confidence, metadata
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repository_id, source_memory_id, target_memory_id, relation_type)
         DO UPDATE SET
           description = excluded.description,
           origin = excluded.origin,
           confidence = excluded.confidence,
           metadata = excluded.metadata`,
        [
          id,
          data.repository_id,
          data.source_id,
          data.target_id,
          data.relation_type,
          data.description ?? null,
          data.origin ?? "manual",
          data.confidence ?? 1,
          JSON.stringify(data.metadata ?? {}),
        ],
      );
      const row = db.get<RelationRow>(
        `SELECT mr.id, mr.repository_id, mr.source_memory_id AS source_id, mr.target_memory_id AS target_id,
          mr.relation_type, mr.description, mr.origin, mr.confidence, mr.metadata, mr.created_at,
          '' AS source_summary, '' AS source_type, '' AS target_summary, '' AS target_type
         FROM memory_relations mr
         WHERE mr.repository_id = ? AND mr.source_memory_id = ? AND mr.target_memory_id = ? AND mr.relation_type = ?`,
        [data.repository_id, data.source_id, data.target_id, data.relation_type],
      );
      if (!row) throw new DatabaseError("INSERT INTO memory_relations did not return a row");
      return toRelation(row);
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
    const params: (string | number)[] = [...entryIds, ...entryIds];
    const repositoryFilter = repositoryId ? "AND mr.repository_id = ?" : "";
    if (repositoryId) {
      params.splice(entryIds.length, 0, repositoryId);
      params.push(repositoryId);
    }
    const activeFilter =
      options?.activeOnly === false
        ? ""
        : options?.includeLineage
          ? `AND (
              (src.valid_until IS NULL AND tgt.valid_until IS NULL
                AND (src.expires_at IS NULL OR src.expires_at > ?)
                AND (tgt.expires_at IS NULL OR tgt.expires_at > ?))
              OR mr.relation_type = 'supersedes'
            )`
          : `AND src.valid_until IS NULL AND tgt.valid_until IS NULL
              AND (src.expires_at IS NULL OR src.expires_at > ?)
              AND (tgt.expires_at IS NULL OR tgt.expires_at > ?)`;
    const timeParams = options?.activeOnly === false ? [] : [new Date().toISOString(), new Date().toISOString()];
    const rows = this.getSql().all<RelationRow>(
      `WITH incidents AS (
         SELECT mr.*
         FROM memory_relations mr
         WHERE mr.source_memory_id IN (${placeholders(entryIds)}) ${repositoryFilter}
         UNION ALL
         SELECT mr.*
         FROM memory_relations mr
         WHERE mr.target_memory_id IN (${placeholders(entryIds)}) ${repositoryFilter}
       ),
       deduped AS (
         SELECT *
         FROM (
           SELECT incidents.*, ROW_NUMBER() OVER (PARTITION BY id ORDER BY created_at DESC) AS rn
           FROM incidents
         )
         WHERE rn = 1
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
       ORDER BY mr.created_at DESC`,
      [...params, ...timeParams],
    );
    return rows.map(toRelation);
  }
}

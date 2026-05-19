import { randomUUID } from "node:crypto";
import { getDb } from "../db/connection.js";
import { DatabaseError, dbQuery } from "../errors.js";
import type { SqlProvider } from "./memory.repository.js";

export type EntityType = "service" | "file" | "package" | "person" | "concept" | "api" | "error" | "env_var";

export interface Entity {
  id: string;
  repository_id: string;
  name: string;
  entity_type: EntityType;
  metadata: Record<string, string | number | boolean | null>;
  created_at: Date;
  updated_at: Date;
}

export interface EntityRelation {
  id: string;
  repository_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relation_type: string;
  description: string | null;
  memory_id: string | null;
  created_at: Date;
}

export interface EntityWithMemoryCount extends Entity {
  memory_count: number;
}

interface EntityRow extends Omit<Entity, "metadata" | "created_at" | "updated_at"> {
  pk: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface EntityRelationRow extends Omit<EntityRelation, "created_at"> {
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

function toEntity(row: EntityRow): Entity {
  const { pk: _pk, metadata, created_at, updated_at, ...rest } = row;
  return { ...rest, metadata: parseMetadata(metadata), created_at: new Date(created_at), updated_at: new Date(updated_at) };
}

function toRelation(row: EntityRelationRow): EntityRelation {
  return { ...row, created_at: new Date(row.created_at) };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

export class EntityRepository {
  private getSql: SqlProvider;

  constructor(sqlProvider?: SqlProvider) {
    this.getSql = sqlProvider ?? getDb;
  }

  withSql(sqlProvider: SqlProvider): EntityRepository {
    return new EntityRepository(sqlProvider);
  }

  async findOrCreate(name: string, entityType: EntityType, repositoryId: string): Promise<Entity> {
    return dbQuery(`EntityRepository.findOrCreate(${name})`, async () => {
      const db = this.getSql();
      const id = randomUUID();
      db.run(
        `INSERT INTO entities (id, repository_id, name, entity_type)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(repository_id, entity_type, name)
         DO UPDATE SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        [id, repositoryId, name, entityType],
      );
      const row = db.get<EntityRow>(
        "SELECT * FROM entities WHERE repository_id = ? AND entity_type = ? AND name = ?",
        [repositoryId, entityType, name],
      );
      if (!row) throw new DatabaseError("Failed to find or create entity");
      return toEntity(row);
    });
  }

  async linkMemory(memoryId: string, entityId: string, relevance = 1.0, repositoryId: string): Promise<void> {
    const db = this.getSql();
    const check = db.get<{ ok: number }>(
      `SELECT (
        EXISTS(
          SELECT 1 FROM memories
          WHERE id = ? AND repository_id = ? AND deleted_at IS NULL
        )
        AND EXISTS(
          SELECT 1 FROM entities
          WHERE id = ? AND repository_id = ?
        )
      ) AS ok`,
      [memoryId, repositoryId, entityId, repositoryId],
    );
    if (!check?.ok) return;
    db.run(
      `INSERT INTO memory_entities (memory_id, repository_id, entity_id, relevance)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(memory_id, entity_id) DO UPDATE SET relevance = excluded.relevance`,
      [memoryId, repositoryId, entityId, relevance],
    );
  }

  async createRelation(data: {
    repositoryId: string;
    sourceId: string;
    targetId: string;
    relationType: string;
    description?: string;
    memoryId?: string;
  }): Promise<EntityRelation> {
    const db = this.getSql();
    const check = db.get<{ ok: number }>(
      `SELECT (
        EXISTS(SELECT 1 FROM entities WHERE id = ? AND repository_id = ?)
        AND EXISTS(SELECT 1 FROM entities WHERE id = ? AND repository_id = ?)
      ) AS ok`,
      [data.sourceId, data.repositoryId, data.targetId, data.repositoryId],
    );
    if (!check?.ok) {
      throw new DatabaseError("Cannot create relation: entities must belong to the same repository");
    }
    const id = randomUUID();
    db.run(
      `INSERT INTO entity_relations (
         id, repository_id, source_entity_id, target_entity_id, relation_type, description, memory_id
       )
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(repository_id, source_entity_id, target_entity_id, relation_type)
       DO UPDATE SET
         description = COALESCE(excluded.description, entity_relations.description),
         memory_id = COALESCE(excluded.memory_id, entity_relations.memory_id)`,
      [id, data.repositoryId, data.sourceId, data.targetId, data.relationType, data.description ?? null, data.memoryId ?? null],
    );
    const row = db.get<EntityRelationRow>(
      `SELECT * FROM entity_relations
       WHERE repository_id = ? AND source_entity_id = ? AND target_entity_id = ? AND relation_type = ?`,
      [data.repositoryId, data.sourceId, data.targetId, data.relationType],
    );
    if (!row) throw new DatabaseError("Failed to create entity relation");
    return toRelation(row);
  }

  async searchByName(
    query: string,
    repositoryId: string,
    limit = 10,
    entityType?: EntityType,
  ): Promise<EntityWithMemoryCount[]> {
    const db = this.getSql();
    const pattern = `%${query.replaceAll("%", " ")}%`;
    const params: (string | number)[] = [repositoryId, pattern];
    let typeFilter = "";
    if (entityType) {
      typeFilter = "AND e.entity_type = ?";
      params.push(entityType);
    }
    const rows = db.all<EntityRow & { memory_count: number }>(
      `WITH matched AS (
         SELECT e.*
         FROM entities e
         JOIN entities_fts ef ON ef.rowid = e.pk
         WHERE e.repository_id = ?
           AND ef.name LIKE ?
           ${typeFilter}
       ),
       counts AS (
         SELECT me.entity_id, COUNT(*) AS memory_count
         FROM memory_entities me
         JOIN matched e ON e.id = me.entity_id
         JOIN memories m
           ON m.id = me.memory_id
          AND m.repository_id = ?
          AND m.deleted_at IS NULL
          AND m.valid_until IS NULL
          AND (m.expires_at IS NULL OR m.expires_at > ?)
         WHERE me.repository_id = ?
         GROUP BY me.entity_id
       )
       SELECT matched.*, COALESCE(c.memory_count, 0) AS memory_count
       FROM matched
       LEFT JOIN counts c ON c.entity_id = matched.id
       ORDER BY memory_count DESC
       LIMIT ?`,
      [...params, repositoryId, new Date().toISOString(), repositoryId, limit],
    );
    return rows.map((row) => ({ ...toEntity(row), memory_count: row.memory_count }));
  }

  async listEntities(repositoryId: string, entityType?: EntityType, limit = 50): Promise<EntityWithMemoryCount[]> {
    const params: (string | number)[] = [repositoryId, new Date().toISOString(), repositoryId];
    const typeFilter = entityType ? "AND e.entity_type = ?" : "";
    if (entityType) params.push(entityType);
    params.push(limit);
    const rows = this.getSql().all<EntityRow & { memory_count: number }>(
      `WITH counts AS (
         SELECT me.entity_id, COUNT(*) AS memory_count
         FROM memory_entities me
         JOIN memories m
           ON m.id = me.memory_id
          AND m.repository_id = ?
          AND m.deleted_at IS NULL
          AND m.valid_until IS NULL
          AND (m.expires_at IS NULL OR m.expires_at > ?)
         WHERE me.repository_id = ?
         GROUP BY me.entity_id
       )
       SELECT e.*, COALESCE(c.memory_count, 0) AS memory_count
       FROM entities e
       LEFT JOIN counts c ON c.entity_id = e.id
       WHERE e.repository_id = ? ${typeFilter}
       ORDER BY memory_count DESC
       LIMIT ?`,
      [...params.slice(0, 3), repositoryId, ...params.slice(3)],
    );
    return rows.map((row) => ({ ...toEntity(row), memory_count: row.memory_count }));
  }

  async findSoftRelatedMemories(
    memoryIds: string[],
    repositoryId: string,
    limit = 10,
  ): Promise<{ memory_id: string; shared_entities: string[]; score: number }[]> {
    if (memoryIds.length === 0) return [];
    const rows = this.getSql().all<{ memory_id: string; shared_entities: string | null; score: number }>(
      `SELECT me2.memory_id,
        json_group_array(DISTINCT e.entity_type || ':' || e.name) AS shared_entities,
        SUM(me1.relevance * me2.relevance) AS score
       FROM memory_entities me1
       JOIN memory_entities me2
         ON me2.repository_id = me1.repository_id
        AND me2.entity_id = me1.entity_id
        AND me2.memory_id NOT IN (${placeholders(memoryIds)})
       JOIN entities e
         ON e.id = me1.entity_id
        AND e.repository_id = ?
       JOIN memories m
         ON m.id = me2.memory_id
        AND m.repository_id = ?
        AND m.deleted_at IS NULL
        AND m.valid_until IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > ?)
       WHERE me1.repository_id = ?
         AND me1.memory_id IN (${placeholders(memoryIds)})
       GROUP BY me2.memory_id
       ORDER BY SUM(me1.relevance * me2.relevance) DESC, COUNT(*) DESC
       LIMIT ?`,
      [...memoryIds, repositoryId, repositoryId, new Date().toISOString(), repositoryId, ...memoryIds, limit],
    );
    return rows.map((row) => ({
      memory_id: row.memory_id,
      shared_entities: row.shared_entities ? (JSON.parse(row.shared_entities) as string[]) : [],
      score: row.score || 0,
    }));
  }
}

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
      const sql = this.getSql();
      const [row] = await sql<Entity[]>`
        INSERT INTO entities (id, repository_id, name, entity_type)
        VALUES (gen_random_uuid(), ${repositoryId}, ${name}, ${entityType})
        ON CONFLICT (repository_id, entity_type, name)
        DO UPDATE SET updated_at = now()
        RETURNING *
      `;
      if (!row) throw new DatabaseError("Failed to find or create entity");
      return row;
    });
  }

  async linkMemory(memoryId: string, entityId: string, relevance = 1.0, repositoryId: string): Promise<void> {
    const sql = this.getSql();
    const [check] = await sql<{ ok: boolean }[]>`
      SELECT (
        EXISTS(
          SELECT 1 FROM memories
          WHERE id = ${memoryId} AND repository_id = ${repositoryId} AND deleted_at IS NULL
        )
        AND EXISTS(
          SELECT 1 FROM entities
          WHERE id = ${entityId} AND repository_id = ${repositoryId}
        )
      ) AS ok
    `;
    if (!check?.ok) return;
    await sql`
      INSERT INTO memory_entities (memory_id, repository_id, entity_id, relevance)
      VALUES (${memoryId}, ${repositoryId}, ${entityId}, ${relevance})
      ON CONFLICT (memory_id, entity_id) DO UPDATE SET relevance = ${relevance}
    `;
  }

  async createRelation(data: {
    repositoryId: string;
    sourceId: string;
    targetId: string;
    relationType: string;
    description?: string;
    memoryId?: string;
  }): Promise<EntityRelation> {
    const sql = this.getSql();
    const [check] = await sql<{ ok: boolean }[]>`
      SELECT (
        EXISTS(SELECT 1 FROM entities WHERE id = ${data.sourceId} AND repository_id = ${data.repositoryId})
        AND EXISTS(SELECT 1 FROM entities WHERE id = ${data.targetId} AND repository_id = ${data.repositoryId})
      ) AS ok
    `;
    if (!check?.ok) {
      throw new DatabaseError("Cannot create relation: entities must belong to the same repository");
    }
    const [row] = await sql<EntityRelation[]>`
      INSERT INTO entity_relations (
        id, repository_id, source_entity_id, target_entity_id, relation_type, description, memory_id
      )
      VALUES (
        gen_random_uuid(),
        ${data.repositoryId},
        ${data.sourceId},
        ${data.targetId},
        ${data.relationType},
        ${data.description ?? null},
        ${data.memoryId ?? null}
      )
      ON CONFLICT (repository_id, source_entity_id, target_entity_id, relation_type)
      DO UPDATE SET
        description = COALESCE(${data.description ?? null}, entity_relations.description),
        memory_id = COALESCE(${data.memoryId ?? null}, entity_relations.memory_id)
      RETURNING *
    `;
    if (!row) throw new DatabaseError("Failed to create entity relation");
    return row;
  }

  async findMemoriesByEntity(
    entityName: string,
    entityType: EntityType,
    repositoryId: string,
    limit = 20,
  ): Promise<{ memory_id: string; relevance: number }[]> {
    const sql = this.getSql();
    return sql<{ memory_id: string; relevance: number }[]>`
      SELECT me.memory_id, me.relevance
      FROM memory_entities me
      JOIN entities e ON e.id = me.entity_id AND e.repository_id = ${repositoryId}
      JOIN memories m ON m.id = me.memory_id
       AND m.repository_id = ${repositoryId}
       AND m.deleted_at IS NULL
       AND m.valid_until IS NULL
      WHERE e.name = ${entityName} AND e.entity_type = ${entityType}
      ORDER BY me.relevance DESC, m.importance DESC
      LIMIT ${limit}
    `;
  }

  async findRelatedEntities(
    entityId: string,
    repositoryId: string,
    depth = 1,
  ): Promise<(EntityRelation & { source_name: string; target_name: string })[]> {
    const sql = this.getSql();
    if (depth <= 1) {
      return sql<(EntityRelation & { source_name: string; target_name: string })[]>`
        SELECT er.*, src.name AS source_name, tgt.name AS target_name
        FROM entity_relations er
        JOIN entities src ON src.id = er.source_entity_id AND src.repository_id = ${repositoryId}
        JOIN entities tgt ON tgt.id = er.target_entity_id AND tgt.repository_id = ${repositoryId}
        WHERE er.repository_id = ${repositoryId}
          AND (er.source_entity_id = ${entityId} OR er.target_entity_id = ${entityId})
        ORDER BY er.created_at DESC
      `;
    }
    return sql<(EntityRelation & { source_name: string; target_name: string })[]>`
      WITH direct AS (
        SELECT CASE
          WHEN source_entity_id = ${entityId} THEN target_entity_id
          ELSE source_entity_id
        END AS related_id
        FROM entity_relations
        WHERE repository_id = ${repositoryId}
          AND (source_entity_id = ${entityId} OR target_entity_id = ${entityId})
      )
      SELECT er.*, src.name AS source_name, tgt.name AS target_name
      FROM entity_relations er
      JOIN entities src ON src.id = er.source_entity_id AND src.repository_id = ${repositoryId}
      JOIN entities tgt ON tgt.id = er.target_entity_id AND tgt.repository_id = ${repositoryId}
      WHERE er.repository_id = ${repositoryId}
        AND (
          er.source_entity_id = ${entityId}
          OR er.target_entity_id = ${entityId}
          OR er.source_entity_id IN (SELECT related_id FROM direct)
          OR er.target_entity_id IN (SELECT related_id FROM direct)
        )
      ORDER BY er.created_at DESC
    `;
  }

  async searchByName(
    query: string,
    repositoryId: string,
    limit = 10,
    entityType?: EntityType,
  ): Promise<EntityWithMemoryCount[]> {
    const sql = this.getSql();
    const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
    const typeFilter = entityType ? sql`AND e.entity_type = ${entityType}` : sql``;
    return sql<EntityWithMemoryCount[]>`
      WITH matched AS MATERIALIZED (
        SELECT e.*
        FROM entities e
        WHERE e.repository_id = ${repositoryId}
          AND e.name ILIKE ${pattern} ESCAPE '\\'
          ${typeFilter}
      ),
      counts AS (
        SELECT me.entity_id, COUNT(*)::int AS memory_count
        FROM memory_entities me
        JOIN matched e ON e.id = me.entity_id
        JOIN memories m ON m.id = me.memory_id
         AND m.repository_id = ${repositoryId}
         AND m.deleted_at IS NULL
         AND m.valid_until IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > now())
        WHERE me.repository_id = ${repositoryId}
        GROUP BY me.entity_id
      )
      SELECT matched.*,
        COALESCE(c.memory_count, 0)::int AS memory_count
      FROM matched
      LEFT JOIN counts c ON c.entity_id = matched.id
      ORDER BY memory_count DESC
      LIMIT ${limit}
    `;
  }

  async listEntities(repositoryId: string, entityType?: EntityType, limit = 50): Promise<EntityWithMemoryCount[]> {
    const sql = this.getSql();
    const typeFilter = entityType ? sql`AND e.entity_type = ${entityType}` : sql``;
    return sql<EntityWithMemoryCount[]>`
      WITH counts AS (
        SELECT me.entity_id, COUNT(*)::int AS memory_count
        FROM memory_entities me
        JOIN memories m ON m.id = me.memory_id
         AND m.repository_id = ${repositoryId}
         AND m.deleted_at IS NULL
         AND m.valid_until IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > now())
        WHERE me.repository_id = ${repositoryId}
        GROUP BY me.entity_id
      )
      SELECT e.*,
        COALESCE(c.memory_count, 0)::int AS memory_count
      FROM entities e
      LEFT JOIN counts c ON c.entity_id = e.id
      WHERE e.repository_id = ${repositoryId} ${typeFilter}
      ORDER BY memory_count DESC
      LIMIT ${limit}
    `;
  }

  async findSoftRelatedMemories(
    memoryIds: string[],
    repositoryId: string,
    limit = 10,
  ): Promise<{ memory_id: string; shared_entities: string[]; score: number }[]> {
    if (memoryIds.length === 0) return [];
    const sql = this.getSql();
    const rows = await sql<{ memory_id: string; shared_entities: string[] | string; score: string }[]>`
      SELECT me2.memory_id,
        ARRAY_AGG(DISTINCT e.entity_type || ':' || e.name ORDER BY e.entity_type || ':' || e.name) AS shared_entities,
        SUM(me1.relevance * me2.relevance)::text AS score
      FROM memory_entities me1
      JOIN memory_entities me2
        ON me2.repository_id = me1.repository_id
       AND me2.entity_id = me1.entity_id
       AND me2.memory_id <> ALL(${memoryIds})
      JOIN entities e
        ON e.id = me1.entity_id
       AND e.repository_id = ${repositoryId}
      JOIN memories m
        ON m.id = me2.memory_id
       AND m.repository_id = ${repositoryId}
       AND m.deleted_at IS NULL
       AND m.valid_until IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > now())
      WHERE me1.repository_id = ${repositoryId}
        AND me1.memory_id = ANY(${memoryIds})
      GROUP BY me2.memory_id
      ORDER BY SUM(me1.relevance * me2.relevance) DESC, COUNT(*) DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      memory_id: row.memory_id,
      shared_entities: Array.isArray(row.shared_entities) ? row.shared_entities : [],
      score: Number(row.score) || 0,
    }));
  }

  async purgeOrphanedEntities(repositoryId: string): Promise<{ entities_deleted: number; relations_deleted: number }> {
    const sql = this.getSql();
    const [relationsResult] = await sql<{ count: number }[]>`
      WITH deleted_relations AS (
        DELETE FROM entity_relations er
        WHERE er.repository_id = ${repositoryId}
          AND (
            NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = er.source_entity_id)
            OR NOT EXISTS (SELECT 1 FROM entities e WHERE e.id = er.target_entity_id)
          )
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM deleted_relations
    `;
    const [entitiesResult] = await sql<{ count: number }[]>`
      WITH deleted_entities AS (
        DELETE FROM entities e
        WHERE e.repository_id = ${repositoryId}
          AND NOT EXISTS (
            SELECT 1 FROM memory_entities me
            JOIN memories m ON m.id = me.memory_id
            WHERE me.entity_id = e.id
              AND me.repository_id = ${repositoryId}
              AND m.deleted_at IS NULL
              AND m.valid_until IS NULL
          )
        RETURNING id
      )
      SELECT COUNT(*)::int AS count FROM deleted_entities
    `;
    return {
      entities_deleted: entitiesResult?.count ?? 0,
      relations_deleted: relationsResult?.count ?? 0,
    };
  }
}

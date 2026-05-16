import { getDb } from "../db/connection.js";
import type { SqlProvider } from "./memory.repository.js";
import { DatabaseError, dbQuery } from "../errors.js";

export interface Entity {
  id: string;
  name: string;
  entity_type: EntityType;
  org_id: string;
  metadata: Record<string, string | number | boolean | null>;
  created_at: Date;
  updated_at: Date;
}

export type EntityType = "service" | "file" | "package" | "person" | "concept" | "api" | "error" | "env_var";

export interface EntityRelation {
  id: string;
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

  /**
   * Find or create an entity by name + type + org. Returns the entity.
   */
  async findOrCreate(name: string, entityType: EntityType, orgId: string): Promise<Entity> {
    return dbQuery(`EntityRepository.findOrCreate(${name})`, async () => {
      const sql = this.getSql();
      const [row] = await sql<Entity[]>`
      INSERT INTO entities (id, name, entity_type, org_id)
      VALUES (gen_random_uuid(), ${name}, ${entityType}, ${orgId})
      ON CONFLICT (org_id, entity_type, name) DO UPDATE SET updated_at = now()
      RETURNING *
    `;
      if (!row) throw new DatabaseError("Failed to find or create entity");
      return row;
    });
  }

  /**
   * Link a memory to an entity.
   */
  async linkMemory(memoryId: string, entityId: string, relevance = 1.0, orgId?: string): Promise<void> {
    const sql = this.getSql();
    // Verify both memory and entity belong to the same org
    if (orgId) {
      const [mem] = await sql<{ id: string }[]>`
        SELECT m.id FROM memories m
        WHERE m.id = ${memoryId} AND m.org_id = ${orgId} AND m.deleted_at IS NULL
      `;
      if (!mem) return; // Memory doesn't belong to this org
      const [ent] = await sql<{ id: string }[]>`
        SELECT e.id FROM entities e
        WHERE e.id = ${entityId} AND e.org_id = ${orgId}
      `;
      if (!ent) return; // Entity doesn't belong to this org
    }
    await sql`
      INSERT INTO memory_entities (memory_id, entity_id, relevance)
      VALUES (${memoryId}, ${entityId}, ${relevance})
      ON CONFLICT (memory_id, entity_id) DO UPDATE SET relevance = ${relevance}
    `;
  }

  /**
   * Create a relationship between two entities.
   */
  async createRelation(data: {
    sourceId: string;
    targetId: string;
    relationType: string;
    description?: string;
    memoryId?: string;
    orgId?: string;
  }): Promise<EntityRelation> {
    const sql = this.getSql();

    // Verify both entities belong to the same org when orgId is provided
    if (data.orgId) {
      const [check] = await sql<{ ok: boolean }[]>`
        SELECT (
          EXISTS(SELECT 1 FROM entities WHERE id = ${data.sourceId} AND org_id = ${data.orgId})
          AND
          EXISTS(SELECT 1 FROM entities WHERE id = ${data.targetId} AND org_id = ${data.orgId})
        ) AS ok
      `;
      if (!check?.ok) {
        throw new DatabaseError("Cannot create relation: entities must belong to the same org");
      }
    }

    const [row] = await sql<EntityRelation[]>`
      INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, description, memory_id)
      VALUES (gen_random_uuid(), ${data.sourceId}, ${data.targetId}, ${data.relationType}, ${data.description ?? null}, ${data.memoryId ?? null})
      ON CONFLICT (source_entity_id, target_entity_id, relation_type) DO UPDATE
        SET description = COALESCE(${data.description ?? null}, entity_relations.description),
            memory_id = COALESCE(${data.memoryId ?? null}, entity_relations.memory_id)
      RETURNING *
    `;
    if (!row) throw new DatabaseError("Failed to create entity relation");
    return row;
  }

  /**
   * Find all memories linked to an entity.
   */
  async findMemoriesByEntity(
    entityName: string,
    entityType: EntityType,
    orgId: string,
    limit = 20,
  ): Promise<{ memory_id: string; relevance: number }[]> {
    const sql = this.getSql();
    return sql<{ memory_id: string; relevance: number }[]>`
      SELECT me.memory_id, me.relevance
      FROM memory_entities me
      JOIN entities e ON e.id = me.entity_id
      JOIN memories m ON m.id = me.memory_id AND m.deleted_at IS NULL AND m.valid_until IS NULL
        AND m.org_id = ${orgId}
      WHERE e.name = ${entityName} AND e.entity_type = ${entityType} AND e.org_id = ${orgId}
      ORDER BY me.relevance DESC, m.importance DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Find entities related to a given entity (graph traversal).
   */
  async findRelatedEntities(
    entityId: string,
    orgId: string,
    depth = 1,
  ): Promise<(EntityRelation & { source_name: string; target_name: string })[]> {
    const sql = this.getSql();
    if (depth <= 1) {
      return sql<(EntityRelation & { source_name: string; target_name: string })[]>`
        SELECT er.*, src.name AS source_name, tgt.name AS target_name
        FROM entity_relations er
        JOIN entities src ON src.id = er.source_entity_id AND src.org_id = ${orgId}
        JOIN entities tgt ON tgt.id = er.target_entity_id AND tgt.org_id = ${orgId}
        WHERE er.source_entity_id = ${entityId} OR er.target_entity_id = ${entityId}
        ORDER BY er.created_at DESC
      `;
    }
    // 2-hop: get direct relations + their relations
    return sql<(EntityRelation & { source_name: string; target_name: string })[]>`
      WITH direct AS (
        SELECT CASE
          WHEN er.source_entity_id = ${entityId} THEN er.target_entity_id
          ELSE er.source_entity_id
        END AS related_id
        FROM entity_relations er
        JOIN entities src ON src.id = er.source_entity_id AND src.org_id = ${orgId}
        JOIN entities tgt ON tgt.id = er.target_entity_id AND tgt.org_id = ${orgId}
        WHERE er.source_entity_id = ${entityId} OR er.target_entity_id = ${entityId}
      )
      SELECT er.*, src.name AS source_name, tgt.name AS target_name
      FROM entity_relations er
      JOIN entities src ON src.id = er.source_entity_id AND src.org_id = ${orgId}
      JOIN entities tgt ON tgt.id = er.target_entity_id AND tgt.org_id = ${orgId}
      WHERE er.source_entity_id = ${entityId}
        OR er.target_entity_id = ${entityId}
        OR er.source_entity_id IN (SELECT related_id FROM direct)
        OR er.target_entity_id IN (SELECT related_id FROM direct)
      ORDER BY er.created_at DESC
    `;
  }

  /**
   * Search entities by name prefix.
   */
  async searchByName(query: string, orgId: string, limit = 10): Promise<EntityWithMemoryCount[]> {
    const sql = this.getSql();
    const pattern = `%${query.replace(/[%_\\]/g, "\\$&")}%`;
    return sql<EntityWithMemoryCount[]>`
      SELECT e.*,
        (SELECT COUNT(*)::int FROM memory_entities me
         JOIN memories m ON m.id = me.memory_id AND m.deleted_at IS NULL AND m.valid_until IS NULL
         WHERE me.entity_id = e.id) AS memory_count
      FROM entities e
      WHERE e.org_id = ${orgId} AND e.name ILIKE ${pattern} ESCAPE '\\'
      ORDER BY memory_count DESC
      LIMIT ${limit}
    `;
  }

  /**
   * Get all entities for an org with memory counts.
   */
  async listEntities(orgId: string, entityType?: EntityType, limit = 50): Promise<EntityWithMemoryCount[]> {
    const sql = this.getSql();
    const typeFilter = entityType ? sql`AND e.entity_type = ${entityType}` : sql``;
    return sql<EntityWithMemoryCount[]>`
      SELECT e.*,
        (SELECT COUNT(*)::int FROM memory_entities me
         JOIN memories m ON m.id = me.memory_id AND m.deleted_at IS NULL AND m.valid_until IS NULL
         WHERE me.entity_id = e.id) AS memory_count
      FROM entities e
      WHERE e.org_id = ${orgId} ${typeFilter}
      ORDER BY memory_count DESC
      LIMIT ${limit}
    `;
  }

  /**
   * GDPR purge: Delete orphaned entities and entity_relations.
   * Entities are orphaned when they have no active memory links.
   * Entity_relations are orphaned when source or target entity no longer exists.
   */
  async purgeOrphanedEntities(orgId: string): Promise<{ entities_deleted: number; relations_deleted: number }> {
    return dbQuery("EntityRepository.purgeOrphanedEntities", async () => {
      const sql = this.getSql();

      // 1. Delete entity_relations where source or target entity doesn't exist
      const [relationsResult] = await sql<{ count: number }[]>`
        WITH deleted_relations AS (
          DELETE FROM entity_relations
          WHERE id IN (
            SELECT er.id
            FROM entity_relations er
            LEFT JOIN entities src ON src.id = er.source_entity_id AND src.org_id = ${orgId}
            LEFT JOIN entities tgt ON tgt.id = er.target_entity_id AND tgt.org_id = ${orgId}
            WHERE src.id IS NULL OR tgt.id IS NULL
          )
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM deleted_relations
      `;

      // 2. Delete entities that have no active memory links
      const [entitiesResult] = await sql<{ count: number }[]>`
        WITH orphaned_entities AS (
          SELECT e.id
          FROM entities e
          WHERE e.org_id = ${orgId}
            AND NOT EXISTS (
              SELECT 1
              FROM memory_entities me
              JOIN memories m ON m.id = me.memory_id
              WHERE me.entity_id = e.id
                AND m.deleted_at IS NULL
                AND m.valid_until IS NULL
            )
        ),
        deleted_entities AS (
          DELETE FROM entities
          WHERE id IN (SELECT id FROM orphaned_entities)
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM deleted_entities
      `;

      return {
        entities_deleted: entitiesResult?.count ?? 0,
        relations_deleted: relationsResult?.count ?? 0,
      };
    });
  }
}

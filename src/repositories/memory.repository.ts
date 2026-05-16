import { getDb } from "../db/connection.js";
import { DatabaseError, dbQuery } from "../errors.js";
import { logger } from "../services/logger.js";
import type { Memory, MemoryType, MemoryScope, RecallResult } from "../types/memory.js";

/** SQL provider function — allows dependency injection for testing and sync. */
export type SqlProvider = () => ReturnType<typeof getDb>;

interface CreateMemoryRow {
  id?: string; // Optional — if provided, used; otherwise DB generates UUID
  team_id: string | null;
  org_id: string;
  user_id: string | null;
  memory_type: MemoryType;
  scope: MemoryScope;
  content: string;
  summary: string;
  importance: number;
  created_by: string;
  source: string | null;
  supersedes: string | null;
  external_id?: string | null | undefined;
  embedding?: number[] | null;
  expires_at?: Date | null | undefined;
  // Sync exclusion
  local_only?: boolean | undefined;
  // Temporal overrides — used by sync to preserve original timestamps
  valid_from?: Date | undefined;
  valid_until?: Date | null | undefined;
  created_at?: Date | undefined;
  updated_at?: Date | undefined;
  // CRDT metadata — used by sync to preserve HLC timestamps
  hlc?: string | undefined;
  field_hlcs?: Record<string, string> | undefined;
  // Group sequence — for ordered memory groups
  group_id?: string | null | undefined;
  sequence?: number | null | undefined;
  group_type?: string | null | undefined;
}

export interface MemoryListFilters {
  team_id?: string | undefined;
  org_id?: string | undefined;
  user_id?: string | undefined;
  scope?: MemoryScope | undefined;
  memory_type?: MemoryType | undefined;
  tags?: string[] | undefined;
  since?: string | undefined;
  local_only?: boolean | undefined;
  limit: number;
  offset: number;
}

interface SearchFilters {
  team_id?: string | undefined;
  org_id?: string | undefined;
  user_id?: string | undefined;
  scope?: MemoryScope | undefined;
  memory_type?: MemoryType | undefined;
  tags?: string[] | undefined;
  local_only?: boolean | undefined;
}

interface SearchRow extends Memory {
  score: number;
  _tags: string | null;
}

interface SimilarRow {
  id: string;
  content: string;
  summary: string;
  similarity: string; // SQL returns numeric as string
}

export function parseJsonTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  try {
    const parsed: unknown = JSON.parse(tags);
    return Array.isArray(parsed) ? (parsed as string[]).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Safely extract the wall time from an HLC string. Returns null on malformed input. */
function parseHlcWall(hlc: string | undefined | null): number | null {
  if (!hlc) return null;
  try {
    const wallStr = hlc.split("-")[0] ?? "0";
    return Number(BigInt(wallStr));
  } catch {
    return null;
  }
}

/** Parse field_hlcs from DB — may be a JSON string (SQLite) or already an object (PG jsonb). */
function parseFieldHlcs(raw: unknown): Partial<Record<string, string>> | null {
  if (!raw) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return raw as Partial<Record<string, string>>;
  }
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as Partial<Record<string, string>>;
    } catch {
      return null;
    }
  }
  return null;
}

export class MemoryRepository {
  private getSql: SqlProvider;

  constructor(sqlProvider?: SqlProvider) {
    this.getSql = sqlProvider ?? getDb;
  }

  /** Create a repository instance scoped to a specific sql connection (e.g. transaction). */
  withSql(sqlProvider: SqlProvider): MemoryRepository {
    return new MemoryRepository(sqlProvider);
  }

  async create(data: CreateMemoryRow): Promise<Memory> {
    return dbQuery("MemoryRepository.create", async () => {
      const sql = this.getSql();
      const embeddingStr = data.embedding ? `[${data.embedding.join(",")}]` : null;

      const idClause = data.id ? sql`${data.id}` : sql`gen_random_uuid()`;
      const hlcWall = parseHlcWall(data.hlc);
      const fieldHlcsStr = data.field_hlcs ? JSON.stringify(data.field_hlcs) : "{}";
      const [row] = await sql<Memory[]>`
      INSERT INTO memories (
        id, team_id, org_id, user_id, memory_type, scope,
        content, summary, importance, created_by, source, supersedes,
        external_id,
        embedding, type, title, status, visibility, author, metadata,
        valid_from, valid_until, last_accessed_at, created_at, updated_at, expires_at,
        hlc, hlc_wall, field_hlcs,
        group_id, sequence, group_type, local_only
      )
      VALUES (
        ${idClause},
        ${data.team_id},
        ${data.org_id},
        ${data.user_id},
        ${data.memory_type},
        ${data.scope},
        ${data.content},
        ${data.summary},
        ${data.importance},
        ${data.created_by},
        ${data.source},
        ${data.supersedes},
        ${data.external_id ?? null},
        ${embeddingStr ? sql`${embeddingStr}::vector` : sql`NULL`},
        ${data.memory_type},
        ${data.summary.substring(0, 200)},
        'active',
        ${data.scope},
        ${data.created_by},
        '{}',
        ${data.valid_from ? sql`${data.valid_from.toISOString()}::timestamptz` : sql`now()`},
        ${data.valid_until ? sql`${data.valid_until.toISOString()}::timestamptz` : sql`NULL`},
        now(),
        ${data.created_at ? sql`${data.created_at.toISOString()}::timestamptz` : sql`now()`},
        ${data.updated_at ? sql`${data.updated_at.toISOString()}::timestamptz` : sql`now()`},
        ${data.expires_at ? sql`${data.expires_at.toISOString()}::timestamptz` : sql`NULL`},
        ${data.hlc ?? null},
        ${hlcWall},
        ${fieldHlcsStr},
        ${data.group_id ?? null},
        ${data.sequence ?? null},
        ${data.group_type ?? null},
        ${data.local_only ?? false}
      )
      RETURNING *
    `;
      if (!row) throw new DatabaseError("INSERT INTO memories did not return a row");
      return this.addTags(row);
    });
  }

  async update(
    id: string,
    data: {
      content?: string | undefined;
      summary?: string | undefined;
      importance?: number | undefined;
      memory_type?: MemoryType | undefined;
      scope?: MemoryScope | undefined;
      valid_until?: Date | null | undefined;
      embedding?: number[] | null | undefined;
      supersedes?: string | null | undefined;
      hlc?: string | undefined;
      field_hlcs?: Record<string, string> | undefined;
    },
    orgId?: string,
  ): Promise<Memory | null> {
    return dbQuery(`MemoryRepository.update(${id})`, async () => {
      const sql = this.getSql();
      const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
      const embeddingStr =
        data.embedding !== undefined ? (data.embedding ? `[${data.embedding.join(",")}]` : null) : undefined;

      const supersedesFragment = data.supersedes !== undefined ? sql`, supersedes = ${data.supersedes ?? null}` : sql``;

      // CRDT metadata
      const hlcFragment =
        data.hlc !== undefined ? sql`, hlc = ${data.hlc}, hlc_wall = ${parseHlcWall(data.hlc)}` : sql``;
      const fieldHlcsFragment =
        data.field_hlcs !== undefined ? sql`, field_hlcs = ${JSON.stringify(data.field_hlcs)}` : sql``;

      const [row] = await sql<Memory[]>`
      UPDATE memories SET
        content = COALESCE(${data.content ?? null}, content),
        summary = COALESCE(${data.summary ?? null}, summary),
        importance = COALESCE(${data.importance ?? null}, importance),
        memory_type = COALESCE(${data.memory_type ?? null}, memory_type),
        scope = COALESCE(${data.scope ?? null}, scope),
        valid_until = ${data.valid_until !== undefined ? (data.valid_until ?? null) : sql`valid_until`},
        embedding = ${embeddingStr !== undefined ? (embeddingStr ? sql`${embeddingStr}::vector` : sql`NULL`) : sql`embedding`},
        updated_at = now()
        ${supersedesFragment}
        ${hlcFragment}
        ${fieldHlcsFragment}
      WHERE id = ${id} AND deleted_at IS NULL ${orgFilter}
      RETURNING *
    `;

      if (!row) return null;
      return this.addTags(row);
    });
  }

  async findById(id: string, orgId?: string): Promise<Memory | null> {
    return dbQuery(`MemoryRepository.findById(${id})`, async () => {
      const sql = this.getSql();
      const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
      const [row] = await sql<Memory[]>`
      SELECT id, team_id, org_id, user_id, memory_type, scope,
        content, summary, importance, created_by, source, supersedes, external_id,
        valid_from, valid_until, created_at, updated_at, expires_at,
        access_count, last_accessed_at, status, type, title, visibility,
        author, metadata, hlc, hlc_wall, field_hlcs, deleted_at,
        group_id, sequence, group_type, local_only
      FROM memories
      WHERE id = ${id} AND deleted_at IS NULL ${orgFilter}
    `;
      if (!row) return null;

      // Lazy TTL expiration: if the memory has expired, soft-delete it on read
      // instead of relying on a background job.
      if (row.expires_at && new Date(row.expires_at) <= new Date()) {
        await sql`
        UPDATE memories
        SET deleted_at = now(), valid_until = now(), status = 'archived', updated_at = now()
        WHERE id = ${id} AND deleted_at IS NULL
      `;
        return null;
      }

      return this.addTags(row);
    });
  }

  /**
   * Find an active (non-invalidated) memory by ID.
   * Returns null if the memory has been invalidated (valid_until IS NOT NULL).
   * Use findById() for internal/admin/sync paths that need all memories.
   */
  async findActiveById(id: string, orgId?: string): Promise<Memory | null> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    const [row] = await sql<Memory[]>`
      SELECT id, team_id, org_id, user_id, memory_type, scope,
        content, summary, importance, created_by, source, supersedes, external_id,
        valid_from, valid_until, created_at, updated_at, expires_at,
        access_count, last_accessed_at, status, type, title, visibility,
        author, metadata, hlc, hlc_wall, field_hlcs, deleted_at,
        group_id, sequence, group_type, local_only
      FROM memories
      WHERE id = ${id} AND deleted_at IS NULL AND valid_until IS NULL ${orgFilter}
    `;
    if (!row) return null;

    // Lazy TTL expiration
    if (row.expires_at && new Date(row.expires_at) <= new Date()) {
      await sql`
        UPDATE memories
        SET deleted_at = now(), valid_until = now(), status = 'archived', updated_at = now()
        WHERE id = ${id} AND deleted_at IS NULL
      `;
      return null;
    }

    return this.addTags(row);
  }

  async findByExternalId(orgId: string, externalId: string): Promise<Memory | null> {
    return dbQuery(`MemoryRepository.findByExternalId(${externalId})`, async () => {
      const sql = this.getSql();
      const [row] = await sql<Memory[]>`
        SELECT id, team_id, org_id, user_id, memory_type, scope,
          content, summary, importance, created_by, source, supersedes, external_id,
          valid_from, valid_until, created_at, updated_at, expires_at,
          access_count, last_accessed_at, status, type, title, visibility,
          author, metadata, hlc, hlc_wall, field_hlcs, deleted_at
        FROM memories
        WHERE org_id = ${orgId} AND external_id = ${externalId} AND deleted_at IS NULL
      `;
      if (!row) return null;
      return this.addTags(row);
    });
  }

  async softDelete(id: string, orgId?: string): Promise<boolean> {
    return dbQuery(`MemoryRepository.softDelete(${id})`, async () => {
      const sql = this.getSql();
      const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
      const [row] = await sql`
      UPDATE memories
      SET deleted_at = now(), valid_until = now(), status = 'archived', updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL ${orgFilter}
      RETURNING id
    `;
      return !!row;
    });
  }

  async invalidate(id: string, orgId?: string): Promise<boolean> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    const [row] = await sql`
      UPDATE memories
      SET valid_until = now(), updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL AND valid_until IS NULL ${orgFilter}
      RETURNING id
    `;
    return !!row;
  }

  async list(filters: MemoryListFilters): Promise<Memory[]> {
    return dbQuery("MemoryRepository.list", async () => {
      const sql = this.getSql();
      const conditions: ReturnType<typeof sql>[] = [
        sql`deleted_at IS NULL`,
        sql`valid_until IS NULL`,
        sql`(expires_at IS NULL OR expires_at > now())`,
      ];

      if (filters.team_id) conditions.push(sql`team_id = ${filters.team_id}`);
      if (filters.org_id) conditions.push(sql`org_id = ${filters.org_id}`);
      if (filters.user_id) {
        conditions.push(sql`(user_id = ${filters.user_id} OR scope != 'personal')`);
      }
      if (filters.scope) conditions.push(sql`scope = ${filters.scope}`);
      if (filters.memory_type) conditions.push(sql`memory_type = ${filters.memory_type}`);
      if (filters.since) conditions.push(sql`created_at >= ${filters.since}::timestamptz`);
      if (filters.local_only !== undefined) conditions.push(sql`local_only = ${filters.local_only}`);

      // Use EXISTS semi-join instead of DISTINCT to avoid deduplication on wide rows
      // (DISTINCT fails on rows containing vector columns)
      if (filters.tags && filters.tags.length > 0) {
        conditions.push(
          sql`EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_id = memories.id AND mt.tag = ANY(${filters.tags}))`,
        );
      }

      const where = conditions.reduce(
        (acc, cond, i) => (i === 0 ? sql`WHERE ${cond}` : sql`${acc} AND ${cond}`),
        sql``,
      );

      const rows = await sql<(Memory & { _tags: string | null })[]>`
      SELECT memories.id, memories.team_id, memories.org_id, memories.user_id, memories.memory_type, memories.scope,
        memories.content, memories.summary, memories.importance, memories.created_by, memories.source, memories.supersedes, memories.external_id,
        memories.valid_from, memories.valid_until, memories.created_at, memories.updated_at, memories.expires_at,
        memories.access_count, memories.last_accessed_at, memories.status, memories.type, memories.title, memories.visibility,
        memories.author, memories.metadata, memories.hlc, memories.hlc_wall, memories.field_hlcs, memories.deleted_at,
        memories.group_id, memories.sequence, memories.group_type,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2 WHERE mt2.memory_id = memories.id) AS _tags
      FROM memories
      ${where}
      ORDER BY updated_at DESC
      LIMIT ${filters.limit} OFFSET ${filters.offset}
    `;

      return rows.map((r) => this.parseTags(r));
    });
  }

  /**
   * List memories for sync — includes invalidated memories (valid_until IS NOT NULL)
   * unlike list() which filters them out. Only excludes hard-deleted.
   */
  async listForSync(since?: Date, limit = 200, orgId?: string, sinceId?: string): Promise<Memory[]> {
    const sql = this.getSql();
    const sinceFilter = since
      ? sinceId
        ? sql`AND (
            updated_at > ${since.toISOString()}::timestamptz
            OR (updated_at = ${since.toISOString()}::timestamptz AND id > ${sinceId})
          )`
        : sql`AND updated_at > ${since.toISOString()}::timestamptz`
      : sql``;
    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;

    const rows = await sql<(Memory & { _tags: string | null })[]>`
      SELECT memories.id, memories.team_id, memories.org_id, memories.user_id, memories.memory_type, memories.scope,
        memories.content, memories.summary, memories.importance, memories.created_by, memories.source, memories.supersedes, memories.external_id,
        memories.valid_from, memories.valid_until, memories.created_at, memories.updated_at, memories.expires_at,
        memories.access_count, memories.last_accessed_at, memories.status, memories.type, memories.title, memories.visibility,
        memories.author, memories.metadata, memories.hlc, memories.hlc_wall, memories.field_hlcs, memories.deleted_at,
        memories.group_id, memories.sequence, memories.group_type, memories.embedding,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2 WHERE mt2.memory_id = memories.id) AS _tags
      FROM memories
      WHERE deleted_at IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND local_only = false
        ${sinceFilter} ${orgFilter}
      ORDER BY updated_at ASC, id ASC
      LIMIT ${limit}
    `;

    return rows.map((r) => this.parseTags(r));
  }

  async searchFts(query: string, filters: SearchFilters, limit: number): Promise<RecallResult[]> {
    return dbQuery("MemoryRepository.searchFts", async () => {
      const sql = this.getSql();
      // Use stored fts_vector column if available, fall back to expression for PGlite
      const conditions: ReturnType<typeof sql>[] = [
        sql`deleted_at IS NULL`,
        sql`valid_until IS NULL`,
        sql`(expires_at IS NULL OR expires_at > now())`,
        sql`fts_vector @@ plainto_tsquery('english', ${query})`,
      ];

      this.applySearchFilters(conditions, filters, sql);

      const where = conditions.reduce(
        (acc, cond, i) => (i === 0 ? sql`WHERE ${cond}` : sql`${acc} AND ${cond}`),
        sql``,
      );

      const rows = await sql<SearchRow[]>`
      SELECT m.id, m.team_id, m.org_id, m.user_id, m.memory_type, m.scope,
        m.content, m.summary, m.importance, m.created_by, m.source, m.supersedes, m.external_id,
        m.valid_from, m.valid_until, m.created_at, m.updated_at, m.expires_at,
        m.access_count, m.last_accessed_at, m.status, m.type, m.title, m.visibility,
        m.author, m.metadata, m.hlc, m.hlc_wall, m.field_hlcs, m.deleted_at,
        m.group_id, m.sequence, m.group_type,
        ts_rank(m.fts_vector, plainto_tsquery('english', ${query})) AS score,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2 WHERE mt2.memory_id = m.id) AS _tags
      FROM memories m
      ${where}
      ORDER BY score DESC
      LIMIT ${limit}
    `;

      return rows.map((r) => this.toRecallResult(r, "fts"));
    });
  }

  async searchSemantic(embedding: number[], filters: SearchFilters, limit: number): Promise<RecallResult[]> {
    return dbQuery("MemoryRepository.searchSemantic", async () => {
      const sql = this.getSql();
      const embeddingStr = `[${embedding.join(",")}]`;
      const conditions: ReturnType<typeof sql>[] = [
        sql`deleted_at IS NULL`,
        sql`valid_until IS NULL`,
        sql`(expires_at IS NULL OR expires_at > now())`,
        sql`embedding IS NOT NULL`,
      ];

      this.applySearchFilters(conditions, filters, sql);

      const where = conditions.reduce(
        (acc, cond, i) => (i === 0 ? sql`WHERE ${cond}` : sql`${acc} AND ${cond}`),
        sql``,
      );

      const rows = await sql<SearchRow[]>`
      SELECT m.id, m.team_id, m.org_id, m.user_id, m.memory_type, m.scope,
        m.content, m.summary, m.importance, m.created_by, m.source, m.supersedes, m.external_id,
        m.valid_from, m.valid_until, m.created_at, m.updated_at, m.expires_at,
        m.access_count, m.last_accessed_at, m.status, m.type, m.title, m.visibility,
        m.author, m.metadata, m.hlc, m.hlc_wall, m.field_hlcs, m.deleted_at,
        m.group_id, m.sequence, m.group_type,
        1 - (m.embedding <=> ${embeddingStr}::vector) AS score,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2 WHERE mt2.memory_id = m.id) AS _tags
      FROM memories m
      ${where}
      ORDER BY m.embedding <=> ${embeddingStr}::vector
      LIMIT ${limit}
    `;

      return rows.map((r) => this.toRecallResult(r, "semantic"));
    });
  }

  async findSimilar(
    embedding: number[],
    threshold: number,
    limit = 5,
    scope?: {
      org_id?: string | undefined;
      team_id?: string | null | undefined;
    },
    excludeId?: string,
  ): Promise<{ id: string; similarity: number; content: string; summary: string }[]> {
    return dbQuery("MemoryRepository.findSimilar", async () => {
      const sql = this.getSql();
      const embeddingStr = `[${embedding.join(",")}]`;

      // Use ORDER BY + LIMIT to leverage HNSW index, then filter by threshold
      // in application code. Putting threshold in WHERE prevents HNSW usage.
      const conditions: ReturnType<typeof sql>[] = [
        sql`deleted_at IS NULL`,
        sql`valid_until IS NULL`,
        sql`embedding IS NOT NULL`,
      ];

      if (excludeId) {
        conditions.push(sql`id != ${excludeId}`);
      }
      if (scope?.org_id) {
        conditions.push(sql`org_id = ${scope.org_id}`);
      }
      if (scope?.team_id) {
        conditions.push(sql`(team_id = ${scope.team_id} OR scope IN ('org', 'public'))`);
      }

      const where = conditions.reduce(
        (acc, cond, i) => (i === 0 ? sql`WHERE ${cond}` : sql`${acc} AND ${cond}`),
        sql``,
      );

      // Fetch more than needed, then filter by threshold in application layer
      const rows = await sql<SimilarRow[]>`
      SELECT id, content, summary,
        1 - (embedding <=> ${embeddingStr}::vector) AS similarity
      FROM memories
      ${where}
      ORDER BY embedding <=> ${embeddingStr}::vector
      LIMIT ${limit * 2}
    `;

      return rows
        .map((r) => ({ ...r, similarity: parseFloat(r.similarity) || 0 }))
        .filter((r) => r.similarity > threshold)
        .slice(0, limit);
    });
  }

  async findByGroupId(
    orgId: string,
    groupId: string,
    options?: { sequence?: number; seqMin?: number; seqMax?: number; limit?: number },
  ): Promise<Memory[]> {
    return dbQuery("MemoryRepository.findByGroupId", async () => {
      const sql = this.getSql();
      const seqFilter =
        options?.sequence !== undefined
          ? sql`AND m.sequence = ${options.sequence}`
          : options?.seqMin !== undefined && options?.seqMax !== undefined
            ? sql`AND m.sequence >= ${options.seqMin} AND m.sequence <= ${options.seqMax}`
            : sql``;
      const limitVal = options?.limit ?? 100;

      const rows = await sql<(Memory & { _tags: string | null })[]>`
        SELECT m.id, m.team_id, m.org_id, m.user_id, m.memory_type, m.scope,
          m.content, m.summary, m.importance, m.created_by, m.source, m.supersedes,
          m.valid_from, m.valid_until, m.created_at, m.updated_at, m.expires_at,
          m.access_count, m.last_accessed_at, m.status, m.type, m.title, m.visibility,
          m.author, m.metadata, m.hlc, m.hlc_wall, m.field_hlcs, m.deleted_at,
          m.group_id, m.sequence, m.group_type,
          (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
           FROM memory_tags mt2 WHERE mt2.memory_id = m.id) AS _tags
        FROM memories m
        WHERE m.group_id = ${groupId}
          AND m.org_id = ${orgId}
          AND m.deleted_at IS NULL
          AND m.valid_until IS NULL
          AND (m.expires_at IS NULL OR m.expires_at > now())
          ${seqFilter}
        ORDER BY m.sequence ASC NULLS LAST
        LIMIT ${limitVal}
      `;

      return rows.map((r) => this.parseTags(r));
    });
  }

  async updateAccessStats(id: string, orgId?: string): Promise<void> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    await sql`
      UPDATE memories SET
        access_count = access_count + 1,
        last_accessed_at = now()
      WHERE id = ${id} AND deleted_at IS NULL ${orgFilter}
    `;
  }

  async batchUpdateAccessStats(ids: string[], orgId?: string): Promise<void> {
    if (ids.length === 0) return;
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    await sql`
      UPDATE memories SET
        access_count = access_count + 1,
        last_accessed_at = now()
      WHERE id = ANY(${ids}) AND deleted_at IS NULL ${orgFilter}
    `;
  }

  async setTags(memoryId: string, tags: string[], orgId?: string): Promise<void> {
    const sql = this.getSql();
    if (orgId) {
      // Verify the memory belongs to this org before modifying tags
      const [mem] =
        await sql`SELECT id FROM memories WHERE id = ${memoryId} AND org_id = ${orgId} AND deleted_at IS NULL`;
      if (!mem) return;
    }
    await sql`DELETE FROM memory_tags WHERE memory_id = ${memoryId}`;
    if (tags.length > 0) {
      const values = tags.map((tag) => ({ memory_id: memoryId, tag }));
      await sql`INSERT INTO memory_tags ${sql(values)}`;
    }
  }

  async getTagsForMemory(memoryId: string, orgId?: string): Promise<string[]> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND m.org_id = ${orgId}` : sql``;
    const rows = await sql<{ tag: string }[]>`
      SELECT mt.tag FROM memory_tags mt
      JOIN memories m ON m.id = mt.memory_id AND m.deleted_at IS NULL ${orgFilter}
      WHERE mt.memory_id = ${memoryId}
      ORDER BY mt.tag
    `;
    return rows.map((r) => r.tag);
  }

  async getAllTags(orgId?: string): Promise<{ tag: string; count: number }[]> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND m.org_id = ${orgId}` : sql``;
    return sql<{ tag: string; count: number }[]>`
      SELECT mt.tag, COUNT(*)::int AS count
      FROM memory_tags mt
      JOIN memories m ON m.id = mt.memory_id AND m.deleted_at IS NULL AND m.valid_until IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) ${orgFilter}
      GROUP BY mt.tag
      ORDER BY count DESC
    `;
  }

  async getStats(
    orgId?: string,
    teamId?: string,
  ): Promise<{
    total_memories: number;
    by_type: Record<string, number>;
    by_scope: Record<string, number>;
    total_tags: number;
    most_accessed: {
      id: string;
      summary: string;
      memory_type: string;
      access_count: number;
    }[];
    stale_count: number;
  }> {
    const sql = this.getSql();

    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    const teamFilter = teamId ? sql`AND team_id = ${teamId}` : sql``;
    const filters = sql`${orgFilter} ${teamFilter}`;

    const [totalRows, byType, byScope, tagRows, mostAccessed, staleRows] = await Promise.all([
      sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL AND (expires_at IS NULL OR expires_at > now()) ${filters}
      `,
      sql<{ memory_type: string; count: number }[]>`
        SELECT memory_type, COUNT(*)::int AS count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL AND (expires_at IS NULL OR expires_at > now()) ${filters}
        GROUP BY memory_type
      `,
      sql<{ scope: string; count: number }[]>`
        SELECT scope, COUNT(*)::int AS count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL AND (expires_at IS NULL OR expires_at > now()) ${filters}
        GROUP BY scope
      `,
      sql<{ count: number }[]>`
        SELECT COUNT(DISTINCT tag)::int AS count FROM memory_tags mt
        JOIN memories m ON m.id = mt.memory_id
        WHERE m.deleted_at IS NULL AND m.valid_until IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) ${filters}
      `,
      sql<
        {
          id: string;
          summary: string;
          memory_type: string;
          access_count: number;
        }[]
      >`
        SELECT id, summary, memory_type, access_count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL AND (expires_at IS NULL OR expires_at > now()) ${filters}
        ORDER BY access_count DESC
        LIMIT 10
      `,
      sql<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL
          AND (expires_at IS NULL OR expires_at > now())
          AND last_accessed_at < now() - interval '90 days'
          ${filters}
      `,
    ]);
    const total_memories = totalRows[0]?.count ?? 0;
    const total_tags = tagRows[0]?.count ?? 0;
    const stale_count = staleRows[0]?.count ?? 0;

    return {
      total_memories,
      by_type: Object.fromEntries(byType.map((r) => [r.memory_type, r.count])),
      by_scope: Object.fromEntries(byScope.map((r) => [r.scope, r.count])),
      total_tags,
      most_accessed: mostAccessed,
      stale_count,
    };
  }

  async findByIds(ids: string[], orgId?: string): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND m.org_id = ${orgId}` : sql``;
    const rows = await sql<(Memory & { _tags: string | null })[]>`
      SELECT m.id, m.team_id, m.org_id, m.user_id, m.memory_type, m.scope,
        m.content, m.summary, m.importance, m.created_by, m.source, m.supersedes, m.external_id,
        m.valid_from, m.valid_until, m.created_at, m.updated_at, m.expires_at,
        m.access_count, m.last_accessed_at, m.status, m.type, m.title, m.visibility,
        m.author, m.metadata, m.hlc, m.hlc_wall, m.field_hlcs, m.deleted_at,
        m.group_id, m.sequence, m.group_type,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2 WHERE mt2.memory_id = m.id) AS _tags
      FROM memories m
      WHERE m.id = ANY(${ids}) AND m.deleted_at IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
        ${orgFilter}
    `;

    // Lazy TTL: soft-delete any expired memories we filtered out (fire-and-forget)
    if (rows.length < ids.length) {
      sql`
        UPDATE memories SET
          deleted_at = now(), valid_until = now(), status = 'archived', updated_at = now()
        WHERE id = ANY(${ids}) AND deleted_at IS NULL
          AND expires_at IS NOT NULL AND expires_at <= now()
      `.catch((err: unknown) => {
        logger.warn("Lazy TTL cleanup failed in findByIds", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return rows.map((r) => this.parseTags(r));
  }

  /**
   * Fetch multiple active (non-invalidated) memories by ID.
   * Filters out invalidated memories (valid_until IS NOT NULL).
   * Use findByIds() for internal/admin/sync paths that need all memories.
   */
  async findActiveByIds(ids: string[], orgId?: string): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND m.org_id = ${orgId}` : sql``;
    const rows = await sql<(Memory & { _tags: string | null })[]>`
      SELECT m.id, m.team_id, m.org_id, m.user_id, m.memory_type, m.scope,
        m.content, m.summary, m.importance, m.created_by, m.source, m.supersedes, m.external_id,
        m.valid_from, m.valid_until, m.created_at, m.updated_at, m.expires_at,
        m.access_count, m.last_accessed_at, m.status, m.type, m.title, m.visibility,
        m.author, m.metadata, m.hlc, m.hlc_wall, m.field_hlcs, m.deleted_at,
        m.group_id, m.sequence, m.group_type,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2 WHERE mt2.memory_id = m.id) AS _tags
      FROM memories m
      WHERE m.id = ANY(${ids}) AND m.deleted_at IS NULL AND m.valid_until IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
        ${orgFilter}
    `;

    // Lazy TTL: soft-delete any expired memories we filtered out (fire-and-forget)
    if (rows.length < ids.length) {
      sql`
        UPDATE memories SET
          deleted_at = now(), valid_until = now(), status = 'archived', updated_at = now()
        WHERE id = ANY(${ids}) AND deleted_at IS NULL
          AND expires_at IS NOT NULL AND expires_at <= now()
      `.catch((err: unknown) => {
        logger.warn("Lazy TTL cleanup failed in findActiveByIds", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return rows.map((r) => this.parseTags(r));
  }

  /**
   * List active memory IDs + content for re-embedding, using cursor-based pagination.
   * Returns memories ordered by id, starting after `afterId`.
   *
   * @param nullOnly - If true, only return memories with NULL embedding (backfill mode).
   */
  async listForReembedding(
    batchSize: number,
    afterId?: string,
    orgId?: string,
    nullOnly?: boolean,
  ): Promise<
    {
      id: string;
      content: string;
      summary: string;
      memory_type: MemoryType;
      scope: MemoryScope;
      source: string | null;
      _tags: string | null;
    }[]
  > {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    const cursorFilter = afterId ? sql`AND id > ${afterId}` : sql``;
    const nullFilter = nullOnly ? sql`AND embedding IS NULL` : sql``;

    return sql<
      {
        id: string;
        content: string;
        summary: string;
        memory_type: MemoryType;
        scope: MemoryScope;
        source: string | null;
        _tags: string | null;
      }[]
    >`
      SELECT id, content, summary, memory_type, scope, source,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2 WHERE mt2.memory_id = memories.id) AS _tags
      FROM memories
      WHERE deleted_at IS NULL AND valid_until IS NULL
        AND (expires_at IS NULL OR expires_at > now())
        ${orgFilter} ${cursorFilter} ${nullFilter}
      ORDER BY id ASC
      LIMIT ${batchSize}
    `;
  }

  /**
   * Search memories by tag prefix (e.g., file:src/services, symbol:MemoryService).
   * Uses the text_pattern_ops index for efficient prefix matching.
   */
  async searchByTagPrefix(
    prefixes: string[],
    scope?: {
      org_id?: string | undefined;
      team_id?: string | undefined;
      user_id?: string | undefined;
    },
    limit = 10,
  ): Promise<Memory[]> {
    if (prefixes.length === 0) return [];
    const sql = this.getSql();

    // Escape LIKE metacharacters before appending wildcard
    const escapeLike = (s: string) => s.replace(/[%_\\]/g, "\\$&");

    // Build OR conditions for each prefix using LIKE with ESCAPE clause
    const prefixConditions = prefixes.map((p) => sql`mt.tag LIKE ${escapeLike(p) + "%"} ESCAPE '\\'`);
    const prefixWhere = prefixConditions.reduce((acc, cond, i) => (i === 0 ? cond : sql`${acc} OR ${cond}`), sql``);

    const conditions: ReturnType<typeof sql>[] = [
      sql`m.deleted_at IS NULL`,
      sql`m.valid_until IS NULL`,
      sql`(m.expires_at IS NULL OR m.expires_at > now())`,
    ];
    if (scope?.org_id) conditions.push(sql`m.org_id = ${scope.org_id}`);
    if (scope?.team_id) {
      conditions.push(sql`(m.team_id = ${scope.team_id} OR m.scope IN ('org', 'public'))`);
    }
    if (scope?.user_id) {
      conditions.push(sql`(m.scope != 'personal' OR m.user_id = ${scope.user_id})`);
    }

    const where = conditions.reduce((acc, cond, i) => (i === 0 ? sql`WHERE ${cond}` : sql`${acc} AND ${cond}`), sql``);

    // Use EXISTS semi-join instead of DISTINCT to avoid deduplication on wide rows
    const rows = await sql<(Memory & { _tags: string | null })[]>`
      SELECT m.id, m.team_id, m.org_id, m.user_id, m.memory_type, m.scope,
        m.content, m.summary, m.importance, m.created_by, m.source, m.supersedes, m.external_id,
        m.valid_from, m.valid_until, m.created_at, m.updated_at, m.expires_at,
        m.access_count, m.last_accessed_at, m.status, m.type, m.title, m.visibility,
        m.author, m.metadata, m.hlc, m.hlc_wall, m.field_hlcs, m.deleted_at,
        m.group_id, m.sequence, m.group_type,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2 WHERE mt2.memory_id = m.id) AS _tags
      FROM memories m
      ${where}
        AND EXISTS (
          SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id AND (${prefixWhere})
        )
      ORDER BY m.importance DESC
      LIMIT ${limit}
    `;

    return rows.map((r) => this.parseTags(r));
  }

  private toRecallResult(r: SearchRow, matchType: "fts" | "semantic"): RecallResult {
    return {
      id: r.id,
      summary: r.summary,
      content: r.content,
      memory_type: r.memory_type,
      scope: r.scope,
      tags: parseJsonTags(r._tags),
      importance: r.importance,
      access_count: r.access_count,
      last_accessed_at: r.last_accessed_at,
      score: r.score,
      match_type: matchType,
      created_at: r.created_at,
      valid_from: r.valid_from,
      valid_until: r.valid_until,
      group_id: r.group_id ?? null,
      sequence: r.sequence ?? null,
      group_type: r.group_type ?? null,
    };
  }

  private applySearchFilters(
    conditions: ReturnType<ReturnType<typeof getDb>>[],
    filters: SearchFilters,
    sql: ReturnType<typeof getDb>,
  ): void {
    if (filters.scope) {
      conditions.push(sql`scope = ${filters.scope}`);
    }
    if (filters.memory_type) {
      conditions.push(sql`memory_type = ${filters.memory_type}`);
    }
    if (filters.team_id) {
      // Include team-scoped AND org/public memories
      conditions.push(sql`(team_id = ${filters.team_id} OR scope IN ('org', 'public'))`);
    }
    if (filters.org_id) {
      conditions.push(sql`org_id = ${filters.org_id}`);
    }
    if (filters.user_id) {
      conditions.push(sql`(user_id = ${filters.user_id} OR scope != 'personal')`);
    }
    if (filters.tags && filters.tags.length > 0) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM memory_tags mt WHERE mt.memory_id = m.id AND mt.tag = ANY(${filters.tags}))`,
      );
    }
    if (filters.local_only !== undefined) {
      conditions.push(sql`local_only = ${filters.local_only}`);
    }
  }

  /**
   * Soft-delete memories whose expires_at has passed. Returns count of expired.
   */
  async expireMemories(batchSize = 100, orgId?: string): Promise<number> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    const rows = await sql<{ id: string }[]>`
      UPDATE memories SET
        deleted_at = now(),
        valid_until = now(),
        status = 'archived',
        updated_at = now()
      WHERE id IN (
        SELECT id FROM memories
        WHERE deleted_at IS NULL
          AND expires_at IS NOT NULL
          AND expires_at <= now()
          ${orgFilter}
        ORDER BY expires_at ASC
        LIMIT ${batchSize}
      )
      RETURNING id
    `;
    return rows.length;
  }

  private async addTags(memory: Memory): Promise<Memory> {
    const tags = await this.getTagsForMemory(memory.id);
    return { ...memory, tags, field_hlcs: parseFieldHlcs(memory.field_hlcs) };
  }

  /**
   * Parse tags from a _tags aggregated column (avoids N+1 queries).
   */
  private parseTags(row: Memory & { _tags?: string | null }): Memory {
    const { _tags, ...memory } = row;
    return {
      ...memory,
      tags: parseJsonTags(_tags),
      field_hlcs: parseFieldHlcs(memory.field_hlcs),
    };
  }
}

// Team queries — kept for backward compatibility
export interface TeamRow {
  id: string;
  slug: string;
  org_id: string;
  name: string;
  metadata: Record<string, string | number | boolean | null>;
  created_at: Date;
  updated_at: Date;
}

export interface TeamWithCount extends TeamRow {
  memory_count: number;
}

export interface TeamSummary extends TeamRow {
  types: { memory_type: string; count: number }[];
  recent_memories: {
    id: string;
    memory_type: string;
    summary: string;
    scope: string;
    importance: number;
    updated_at: Date;
  }[];
}

export class TeamRepository {
  private getSql: SqlProvider;

  constructor(sqlProvider?: SqlProvider) {
    this.getSql = sqlProvider ?? getDb;
  }

  async findById(id: string): Promise<TeamRow | null> {
    const sql = this.getSql();
    const [row] = await sql<TeamRow[]>`SELECT * FROM teams WHERE id = ${id}`;
    return row ?? null;
  }

  async findBySlug(slug: string, orgId?: string): Promise<TeamRow | null> {
    const sql = this.getSql();
    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    const [row] = await sql<TeamRow[]>`SELECT * FROM teams WHERE slug = ${slug} ${orgFilter}`;
    return row ?? null;
  }

  async findOrCreate(slug: string, name?: string, orgId?: string): Promise<TeamRow> {
    const sql = this.getSql();
    const org = orgId ?? "default";
    // Use INSERT ... ON CONFLICT DO UPDATE to always return a row atomically
    const [row] = await sql<TeamRow[]>`
      INSERT INTO teams (id, slug, name, org_id) VALUES (gen_random_uuid(), ${slug}, ${name ?? slug}, ${org})
      ON CONFLICT (slug, org_id) DO UPDATE SET slug = EXCLUDED.slug
      RETURNING *
    `;
    if (!row) throw new DatabaseError(`Failed to find or create team: ${slug}`);
    return row;
  }

  async listAll(orgId?: string): Promise<TeamWithCount[]> {
    const sql = this.getSql();
    if (orgId) {
      // Only return teams that have at least one memory in this org (tenant isolation)
      return sql<TeamWithCount[]>`
        SELECT t.*,
          COUNT(m.id)::int AS memory_count
        FROM teams t
        INNER JOIN memories m ON m.team_id = t.id AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now()) AND m.org_id = ${orgId}
        GROUP BY t.id
        ORDER BY t.name
      `;
    }
    return sql<TeamWithCount[]>`
      SELECT t.*,
        (SELECT COUNT(*)::int FROM memories m WHERE m.team_id = t.id AND m.deleted_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > now())) AS memory_count
      FROM teams t
      ORDER BY t.name
    `;
  }

  async getTeamSummary(slug: string, orgId?: string): Promise<TeamSummary | null> {
    const sql = this.getSql();
    const teamOrgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;
    const [team] = await sql<TeamRow[]>`SELECT * FROM teams WHERE slug = ${slug} ${teamOrgFilter}`;
    if (!team) return null;

    const orgFilter = orgId ? sql`AND org_id = ${orgId}` : sql``;

    const types = await sql<{ memory_type: string; count: number }[]>`
      SELECT memory_type, COUNT(*)::int AS count
      FROM memories
      WHERE team_id = ${team.id} AND deleted_at IS NULL AND valid_until IS NULL AND (expires_at IS NULL OR expires_at > now()) ${orgFilter}
      GROUP BY memory_type
    `;
    const recentMemories = await sql<
      {
        id: string;
        memory_type: string;
        summary: string;
        scope: string;
        importance: number;
        updated_at: Date;
      }[]
    >`
      SELECT id, memory_type, summary, scope, importance, updated_at
      FROM memories
      WHERE team_id = ${team.id} AND deleted_at IS NULL AND valid_until IS NULL AND (expires_at IS NULL OR expires_at > now()) ${orgFilter}
      ORDER BY updated_at DESC
      LIMIT 10
    `;

    return { ...team, types, recent_memories: recentMemories };
  }
}

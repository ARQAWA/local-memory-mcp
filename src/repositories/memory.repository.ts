import { getDb } from "../db/connection.js";
import { DatabaseError, dbQuery } from "../errors.js";
import type { RepositoryIdentity } from "../services/git-identity.service.js";
import type { Memory, MemoryStats, MemoryType, RecallResult, RepositoryRecord } from "../types/memory.js";

export type SqlProvider = () => ReturnType<typeof getDb>;
type Sql = ReturnType<typeof getDb>;
type SqlFragment = ReturnType<Sql>;

interface CreateMemoryRow {
  id?: string;
  repository_id: string;
  user_id: string | null;
  memory_type: MemoryType;
  content: string;
  summary: string;
  importance: number;
  created_by: string;
  source: string | null;
  supersedes: string | null;
  external_id?: string | null | undefined;
  embedding?: number[] | null;
  valid_from?: Date | undefined;
  valid_until?: Date | null | undefined;
  created_at?: Date | undefined;
  updated_at?: Date | undefined;
  expires_at?: Date | null | undefined;
  group_id?: string | null | undefined;
  sequence?: number | null | undefined;
  group_type?: string | null | undefined;
}

export interface MemoryListFilters {
  repository_id?: string | undefined;
  user_id?: string | undefined;
  memory_type?: MemoryType | undefined;
  tags?: string[] | undefined;
  since?: string | undefined;
  limit: number;
  offset: number;
}

interface SearchFilters {
  repository_id?: string | undefined;
  memory_type?: MemoryType | undefined;
  tags?: string[] | undefined;
}

interface SearchRow extends Memory {
  score: number;
  _tags: string | null;
}

interface SimilarRow {
  id: string;
  content: string;
  summary: string;
  similarity: string;
}

export function parseJsonTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string" && t.length > 0) : [];
  } catch {
    return [];
  }
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0 && !t.startsWith("repo:")))].slice(0, 100);
}

function embeddingLiteral(embedding: number[] | null | undefined): string | null | undefined {
  if (embedding === undefined) return undefined;
  return embedding ? `[${embedding.join(",")}]` : null;
}

export class MemoryRepository {
  private getSql: SqlProvider;

  constructor(sqlProvider?: SqlProvider) {
    this.getSql = sqlProvider ?? getDb;
  }

  withSql(sqlProvider: SqlProvider): MemoryRepository {
    return new MemoryRepository(sqlProvider);
  }

  async ensureRepository(identity: RepositoryIdentity): Promise<RepositoryRecord> {
    return dbQuery("MemoryRepository.ensureRepository", async () => {
      const sql = this.getSql();
      const existingByRoot = await sql<RepositoryRecord[]>`
        SELECT * FROM repositories WHERE root_hash = ${identity.repository_root_hash} LIMIT 1
      `;
      const current = existingByRoot[0];
      if (current) {
        const [row] = await sql<RepositoryRecord[]>`
          UPDATE repositories
          SET name = ${identity.repository_name},
              root_path = ${identity.repository_root},
              remote_url_hash = ${identity.repository_remote_url_hash ?? null},
              metadata = COALESCE(metadata, '{}'::jsonb)
                || ${sql.json({ identity_kind: identity.repository_identity_kind })}::jsonb,
              last_seen_at = now(),
              updated_at = now()
          WHERE id = ${current.id}
          RETURNING *
        `;
        if (!row) throw new DatabaseError("Failed to update repository identity");
        return row;
      }

      const slugRows = await sql<{ id: string }[]>`
        SELECT id FROM repositories WHERE slug = ${identity.repository_slug} LIMIT 1
      `;
      const slug = slugRows[0]
        ? `${identity.repository_slug}-${identity.repository_root_hash.slice(0, 8)}`
        : identity.repository_slug;
      const [row] = await sql<RepositoryRecord[]>`
        INSERT INTO repositories (id, slug, name, root_path, root_hash, remote_url_hash, metadata)
        VALUES (
          gen_random_uuid(),
          ${slug},
          ${identity.repository_name},
          ${identity.repository_root},
          ${identity.repository_root_hash},
          ${identity.repository_remote_url_hash ?? null},
          ${sql.json({ identity_kind: identity.repository_identity_kind })}::jsonb
        )
        RETURNING *
      `;
      if (!row) throw new DatabaseError("Failed to create repository");
      return row;
    });
  }

  async findRepository(identifier: string): Promise<RepositoryRecord | null> {
    const sql = this.getSql();
    const [row] = await sql<RepositoryRecord[]>`
      SELECT * FROM repositories
      WHERE id::text = ${identifier} OR slug = ${identifier}
      LIMIT 1
    `;
    return row ?? null;
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const sql = this.getSql();
    return sql<RepositoryRecord[]>`
      SELECT r.*,
        COUNT(m.id)::int AS memory_count
      FROM repositories r
      LEFT JOIN memories m
        ON m.repository_id = r.id
       AND m.deleted_at IS NULL
       AND m.valid_until IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > now())
      GROUP BY r.id
      ORDER BY memory_count DESC, r.slug ASC
    `;
  }

  async create(data: CreateMemoryRow): Promise<Memory> {
    return dbQuery("MemoryRepository.create", async () => {
      const sql = this.getSql();
      const vector = embeddingLiteral(data.embedding);
      const [row] = await sql<Memory[]>`
        INSERT INTO memories (
          id, repository_id, user_id, memory_type,
          content, summary, importance, created_by, source, supersedes,
          external_id, embedding, valid_from, valid_until, last_accessed_at,
          created_at, updated_at, expires_at, group_id, sequence, group_type
        )
        VALUES (
          ${data.id ? sql`${data.id}` : sql`gen_random_uuid()`},
          ${data.repository_id},
          ${data.user_id},
          ${data.memory_type},
          ${data.content},
          ${data.summary},
          ${data.importance},
          ${data.created_by},
          ${data.source},
          ${data.supersedes},
          ${data.external_id ?? null},
          ${vector ? sql`${vector}::vector` : sql`NULL`},
          ${data.valid_from ? sql`${data.valid_from.toISOString()}::timestamptz` : sql`now()`},
          ${data.valid_until ? sql`${data.valid_until.toISOString()}::timestamptz` : sql`NULL`},
          now(),
          ${data.created_at ? sql`${data.created_at.toISOString()}::timestamptz` : sql`now()`},
          ${data.updated_at ? sql`${data.updated_at.toISOString()}::timestamptz` : sql`now()`},
          ${data.expires_at ? sql`${data.expires_at.toISOString()}::timestamptz` : sql`NULL`},
          ${data.group_id ?? null},
          ${data.sequence ?? null},
          ${data.group_type ?? null}
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
      valid_until?: Date | null | undefined;
      embedding?: number[] | null | undefined;
      supersedes?: string | null | undefined;
    },
    repositoryId?: string,
  ): Promise<Memory | null> {
    return dbQuery(`MemoryRepository.update(${id})`, async () => {
      const sql = this.getSql();
      const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
      const vector = embeddingLiteral(data.embedding);
      const [row] = await sql<Memory[]>`
        UPDATE memories SET
          content = COALESCE(${data.content ?? null}, content),
          summary = COALESCE(${data.summary ?? null}, summary),
          importance = COALESCE(${data.importance ?? null}, importance),
          memory_type = COALESCE(${data.memory_type ?? null}, memory_type),
          valid_until = ${data.valid_until !== undefined ? (data.valid_until ?? null) : sql`valid_until`},
          embedding = ${vector !== undefined ? (vector ? sql`${vector}::vector` : sql`NULL`) : sql`embedding`},
          supersedes = ${data.supersedes !== undefined ? (data.supersedes ?? null) : sql`supersedes`},
          updated_at = now()
        WHERE id = ${id} AND deleted_at IS NULL ${repositoryFilter}
        RETURNING *
      `;
      return row ? this.addTags(row) : null;
    });
  }

  async findById(id: string, repositoryId?: string, options?: { activeOnly?: boolean }): Promise<Memory | null> {
    return dbQuery(`MemoryRepository.findById(${id})`, async () => {
      const sql = this.getSql();
      const repositoryFilter = repositoryId ? sql`AND m.repository_id = ${repositoryId}` : sql``;
      const activeFilter = options?.activeOnly ? sql`AND m.valid_until IS NULL` : sql``;
      const [row] = await sql<(Memory & { _tags: string | null })[]>`
        ${this.selectMemorySql()}
        WHERE m.id = ${id}
          AND m.deleted_at IS NULL
          ${activeFilter}
          ${repositoryFilter}
      `;
      if (!row) return null;
      if (row.expires_at && new Date(row.expires_at) <= new Date()) {
        await this.softDelete(id, repositoryId);
        return null;
      }
      return this.parseTags(row);
    });
  }

  async findActiveById(id: string, repositoryId?: string): Promise<Memory | null> {
    return this.findById(id, repositoryId, { activeOnly: true });
  }

  async findByExternalId(repositoryId: string, externalId: string): Promise<Memory | null> {
    const sql = this.getSql();
    const [row] = await sql<(Memory & { _tags: string | null })[]>`
      ${this.selectMemorySql()}
      WHERE m.repository_id = ${repositoryId}
        AND m.external_id = ${externalId}
        AND m.deleted_at IS NULL
      LIMIT 1
    `;
    return row ? this.parseTags(row) : null;
  }

  async softDelete(id: string, repositoryId?: string): Promise<boolean> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
    const [row] = await sql`
      UPDATE memories
      SET deleted_at = now(), valid_until = now(), updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL ${repositoryFilter}
      RETURNING id
    `;
    return !!row;
  }

  async invalidate(id: string, repositoryId?: string): Promise<boolean> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
    const [row] = await sql`
      UPDATE memories
      SET valid_until = now(), updated_at = now()
      WHERE id = ${id} AND deleted_at IS NULL AND valid_until IS NULL ${repositoryFilter}
      RETURNING id
    `;
    return !!row;
  }

  async list(filters: MemoryListFilters): Promise<Memory[]> {
    return dbQuery("MemoryRepository.list", async () => {
      const sql = this.getSql();
      const conditions = this.activeConditions(sql);
      this.applyListFilters(conditions, filters, sql);
      const where = this.where(conditions, sql);
      const rows = await sql<(Memory & { _tags: string | null })[]>`
        ${this.selectMemorySql()}
        ${where}
        ORDER BY m.updated_at DESC
        LIMIT ${filters.limit} OFFSET ${filters.offset}
      `;
      return rows.map((r) => this.parseTags(r));
    });
  }

  async searchFts(query: string, filters: SearchFilters, limit: number): Promise<RecallResult[]> {
    return dbQuery("MemoryRepository.searchFts", async () => {
      const sql = this.getSql();
      const conditions: SqlFragment[] = [
        ...this.activeConditions(sql),
        sql`m.fts_vector @@ plainto_tsquery('english', ${query})`,
      ];
      this.applySearchFilters(conditions, filters, sql);
      const where = this.where(conditions, sql);
      const rows = await sql<SearchRow[]>`
        ${this.selectMemorySql(sql`ts_rank(m.fts_vector, plainto_tsquery('english', ${query})) AS score,`)}
        ${where}
        ORDER BY score DESC, m.updated_at DESC
        LIMIT ${limit}
      `;
      return rows.map((r) => this.toRecallResult(r, "fts"));
    });
  }

  async searchSemantic(embedding: number[], filters: SearchFilters, limit: number): Promise<RecallResult[]> {
    return dbQuery("MemoryRepository.searchSemantic", async () => {
      const sql = this.getSql();
      const vector = `[${embedding.join(",")}]`;
      const conditions: SqlFragment[] = [...this.activeConditions(sql), sql`m.embedding IS NOT NULL`];
      this.applySearchFilters(conditions, filters, sql);
      const where = this.where(conditions, sql);

      const rows = filters.repository_id
        ? await sql<SearchRow[]>`
            WITH repo_candidates AS MATERIALIZED (
              SELECT m.id, m.repository_id, m.embedding
              FROM memories m
              ${where}
            ),
            ranked AS (
              SELECT
                id,
                repository_id,
                1 - (embedding <=> ${vector}::vector) AS score
              FROM repo_candidates
              ORDER BY embedding <=> ${vector}::vector
              LIMIT ${limit}
            )
            ${this.selectMemorySql(
              sql`ranked.score AS score,`,
              undefined,
              sql`
              JOIN ranked ON ranked.id = m.id AND ranked.repository_id = m.repository_id
            `,
            )}
            ORDER BY ranked.score DESC
          `
        : await sql<SearchRow[]>`
            ${this.selectMemorySql(sql`1 - (m.embedding <=> ${vector}::vector) AS score,`)}
            ${where}
            ORDER BY m.embedding <=> ${vector}::vector
            LIMIT ${limit}
          `;
      return rows.map((r) => this.toRecallResult(r, "semantic"));
    });
  }

  async findSimilar(
    embedding: number[],
    threshold: number,
    limit = 5,
    repositoryId?: string,
    excludeId?: string,
  ): Promise<{ id: string; similarity: number; content: string; summary: string }[]> {
    const sql = this.getSql();
    const vector = `[${embedding.join(",")}]`;
    const conditions: SqlFragment[] = [...this.activeConditions(sql), sql`m.embedding IS NOT NULL`];
    if (repositoryId) conditions.push(sql`m.repository_id = ${repositoryId}`);
    if (excludeId) conditions.push(sql`m.id != ${excludeId}`);
    const where = this.where(conditions, sql);
    const rows = repositoryId
      ? await sql<SimilarRow[]>`
          WITH repo_candidates AS MATERIALIZED (
            SELECT m.id, m.embedding
            FROM memories m
            ${where}
          ),
          ranked AS (
            SELECT
              id,
              1 - (embedding <=> ${vector}::vector) AS similarity
            FROM repo_candidates
            ORDER BY embedding <=> ${vector}::vector
            LIMIT ${limit * 2}
          )
          SELECT m.id, m.content, m.summary, ranked.similarity
          FROM ranked
          JOIN memories m ON m.id = ranked.id
          ORDER BY ranked.similarity DESC
        `
      : await sql<SimilarRow[]>`
          SELECT m.id, m.content, m.summary, 1 - (m.embedding <=> ${vector}::vector) AS similarity
          FROM memories m
          ${where}
          ORDER BY m.embedding <=> ${vector}::vector
          LIMIT ${limit * 2}
        `;
    return rows
      .map((r) => ({ ...r, similarity: parseFloat(r.similarity) || 0 }))
      .filter((r) => r.similarity > threshold)
      .slice(0, limit);
  }

  async findByGroupId(
    repositoryId: string | undefined,
    groupId: string,
    options?: { sequence?: number; seqMin?: number; seqMax?: number; limit?: number },
  ): Promise<Memory[]> {
    const sql = this.getSql();
    const conditions: SqlFragment[] = [...this.activeConditions(sql), sql`m.group_id = ${groupId}`];
    if (repositoryId) conditions.push(sql`m.repository_id = ${repositoryId}`);
    if (options?.sequence !== undefined) conditions.push(sql`m.sequence = ${options.sequence}`);
    if (options?.seqMin !== undefined && options.seqMax !== undefined) {
      conditions.push(sql`m.sequence >= ${options.seqMin} AND m.sequence <= ${options.seqMax}`);
    }
    const where = this.where(conditions, sql);
    const rows = await sql<(Memory & { _tags: string | null })[]>`
      ${this.selectMemorySql()}
      ${where}
      ORDER BY m.sequence ASC NULLS LAST
      LIMIT ${options?.limit ?? 100}
    `;
    return rows.map((r) => this.parseTags(r));
  }

  async updateAccessStats(id: string, repositoryId?: string): Promise<void> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
    await sql`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed_at = now()
      WHERE id = ${id} AND deleted_at IS NULL ${repositoryFilter}
    `;
  }

  async batchUpdateAccessStats(ids: string[], repositoryId?: string): Promise<void> {
    if (ids.length === 0) return;
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
    await sql`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed_at = now()
      WHERE id = ANY(${ids}) AND deleted_at IS NULL ${repositoryFilter}
    `;
  }

  async setTags(memoryId: string, tags: string[], repositoryId: string): Promise<void> {
    const sql = this.getSql();
    const safeTags = cleanTags(tags);
    await sql`DELETE FROM memory_tags WHERE memory_id = ${memoryId}`;
    for (const tag of safeTags) {
      await sql`
        INSERT INTO memory_tags (memory_id, repository_id, tag)
        VALUES (${memoryId}, ${repositoryId}, ${tag})
        ON CONFLICT (memory_id, tag) DO NOTHING
      `;
    }
  }

  async getTagsForMemory(memoryId: string, repositoryId?: string): Promise<string[]> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
    const rows = await sql<{ tag: string }[]>`
      SELECT tag FROM memory_tags WHERE memory_id = ${memoryId} ${repositoryFilter} ORDER BY tag
    `;
    return rows.map((r) => r.tag);
  }

  async getAllTags(repositoryId?: string): Promise<{ tag: string; count: number }[]> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND mt.repository_id = ${repositoryId}` : sql``;
    return sql<{ tag: string; count: number }[]>`
      SELECT mt.tag, COUNT(*)::int AS count
      FROM memory_tags mt
      JOIN memories m ON m.id = mt.memory_id
      WHERE m.deleted_at IS NULL
        AND m.valid_until IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
        ${repositoryFilter}
      GROUP BY mt.tag
      ORDER BY count DESC, mt.tag ASC
      LIMIT 500
    `;
  }

  async getStats(repositoryId?: string): Promise<MemoryStats> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND m.repository_id = ${repositoryId}` : sql``;
    const repositoryRowsFilter = repositoryId ? sql`WHERE r.id = ${repositoryId}` : sql``;
    const [repository] = repositoryId
      ? await sql<RepositoryRecord[]>`SELECT * FROM repositories WHERE id = ${repositoryId}`
      : [null];
    const [totalRow, typeRows, repositoryRows, recentRows, staleRows, avgRows, mostAccessed, topTags] =
      await Promise.all([
        sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM memories m
          WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > now()) ${repositoryFilter}
        `,
        sql<{ memory_type: string; count: number }[]>`
          SELECT m.memory_type, COUNT(*)::int AS count FROM memories m
          WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > now()) ${repositoryFilter}
          GROUP BY m.memory_type
        `,
        sql<{ slug: string; count: number }[]>`
          SELECT r.slug, COUNT(m.id)::int AS count
          FROM repositories r
          LEFT JOIN memories m
            ON m.repository_id = r.id
           AND m.deleted_at IS NULL
           AND m.valid_until IS NULL
           AND (m.expires_at IS NULL OR m.expires_at > now())
          ${repositoryRowsFilter}
          GROUP BY r.slug
          ORDER BY count DESC, r.slug ASC
        `,
        sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM memories m
          WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > now())
            AND m.created_at >= now() - interval '7 days' ${repositoryFilter}
        `,
        sql<{ count: number }[]>`
          SELECT COUNT(*)::int AS count FROM memories m
          WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > now())
            AND m.last_accessed_at < now() - interval '90 days' ${repositoryFilter}
        `,
        sql<{ avg: string }[]>`
          SELECT COALESCE(AVG(m.importance), 0)::text AS avg FROM memories m
          WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > now()) ${repositoryFilter}
        `,
        this.list({ repository_id: repositoryId, limit: 10, offset: 0 }),
        this.getAllTags(repositoryId),
      ]);

    return {
      repository: repository ?? null,
      total: totalRow[0]?.count ?? 0,
      by_type: Object.fromEntries(typeRows.map((r) => [r.memory_type, r.count])),
      by_repository: Object.fromEntries(repositoryRows.map((r) => [r.slug, r.count])),
      top_tags: topTags.slice(0, 30),
      most_accessed: mostAccessed.sort((a, b) => b.access_count - a.access_count).slice(0, 10),
      recent_count: recentRows[0]?.count ?? 0,
      stale_count: staleRows[0]?.count ?? 0,
      avg_importance: parseFloat(avgRows[0]?.avg ?? "0"),
    };
  }

  async findByIds(ids: string[], repositoryId?: string): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND m.repository_id = ${repositoryId}` : sql``;
    const rows = await sql<(Memory & { _tags: string | null })[]>`
      ${this.selectMemorySql()}
      WHERE m.id = ANY(${ids}) AND m.deleted_at IS NULL ${repositoryFilter}
    `;
    return rows.map((r) => this.parseTags(r));
  }

  async findActiveByIds(ids: string[], repositoryId?: string): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND m.repository_id = ${repositoryId}` : sql``;
    const rows = await sql<(Memory & { _tags: string | null })[]>`
      ${this.selectMemorySql()}
      WHERE m.id = ANY(${ids})
        AND m.deleted_at IS NULL
        AND m.valid_until IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
        ${repositoryFilter}
    `;
    return rows.map((r) => this.parseTags(r));
  }

  async listForReembedding(limit = 100, nullOnly = false, repositoryId?: string): Promise<Memory[]> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND m.repository_id = ${repositoryId}` : sql``;
    const nullFilter = nullOnly ? sql`AND m.embedding IS NULL` : sql``;
    const rows = await sql<(Memory & { _tags: string | null })[]>`
      ${this.selectMemorySql()}
      WHERE m.deleted_at IS NULL
        AND m.valid_until IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
        ${repositoryFilter}
        ${nullFilter}
      ORDER BY m.updated_at ASC
      LIMIT ${limit}
    `;
    return rows.map((r) => this.parseTags(r));
  }

  async searchByTagPrefix(
    prefix: string,
    repositoryId?: string,
    limit = 20,
  ): Promise<{ tag: string; count: number }[]> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND mt.repository_id = ${repositoryId}` : sql``;
    return sql<{ tag: string; count: number }[]>`
      SELECT mt.tag, COUNT(*)::int AS count
      FROM memory_tags mt
      JOIN memories m ON m.id = mt.memory_id
      WHERE mt.tag LIKE ${`${prefix}%`}
        AND m.deleted_at IS NULL
        AND m.valid_until IS NULL
        AND (m.expires_at IS NULL OR m.expires_at > now())
        ${repositoryFilter}
      GROUP BY mt.tag
      ORDER BY count DESC, mt.tag ASC
      LIMIT ${limit}
    `;
  }

  async expireMemories(batchSize = 100, repositoryId?: string): Promise<number> {
    const sql = this.getSql();
    const repositoryFilter = repositoryId ? sql`AND repository_id = ${repositoryId}` : sql``;
    const rows = await sql<{ id: string }[]>`
      UPDATE memories
      SET deleted_at = now(), valid_until = now(), updated_at = now()
      WHERE id IN (
        SELECT id FROM memories
        WHERE deleted_at IS NULL
          AND valid_until IS NULL
          AND expires_at IS NOT NULL
          AND expires_at <= now()
          ${repositoryFilter}
        LIMIT ${batchSize}
      )
      RETURNING id
    `;
    return rows.length;
  }

  private activeConditions(sql: Sql): SqlFragment[] {
    return [sql`m.deleted_at IS NULL`, sql`m.valid_until IS NULL`, sql`(m.expires_at IS NULL OR m.expires_at > now())`];
  }

  private applyListFilters(conditions: SqlFragment[], filters: MemoryListFilters, sql: Sql): void {
    if (filters.repository_id) conditions.push(sql`m.repository_id = ${filters.repository_id}`);
    if (filters.user_id) conditions.push(sql`m.user_id = ${filters.user_id}`);
    if (filters.memory_type) conditions.push(sql`m.memory_type = ${filters.memory_type}`);
    if (filters.since) conditions.push(sql`m.created_at >= ${filters.since}::timestamptz`);
    if (filters.tags?.length) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM memory_tags mt
        WHERE mt.memory_id = m.id
          AND mt.repository_id = m.repository_id
          AND mt.tag = ANY(${filters.tags})
      )`);
    }
  }

  private applySearchFilters(conditions: SqlFragment[], filters: SearchFilters, sql: Sql): void {
    if (filters.repository_id) conditions.push(sql`m.repository_id = ${filters.repository_id}`);
    if (filters.memory_type) conditions.push(sql`m.memory_type = ${filters.memory_type}`);
    if (filters.tags?.length) {
      conditions.push(sql`EXISTS (
        SELECT 1 FROM memory_tags mt
        WHERE mt.memory_id = m.id
          AND mt.repository_id = m.repository_id
          AND mt.tag = ANY(${filters.tags})
      )`);
    }
  }

  private where(conditions: SqlFragment[], sql: Sql): SqlFragment {
    return conditions.reduce((acc, cond, i) => (i === 0 ? sql`WHERE ${cond}` : sql`${acc} AND ${cond}`), sql``);
  }

  private selectMemorySql(extra?: SqlFragment, from?: SqlFragment, extraJoin?: SqlFragment): SqlFragment {
    const sql = this.getSql();
    return sql`
      SELECT
        ${extra ?? sql``}
        m.id, m.repository_id, r.slug AS repository_slug, r.name AS repository_name,
        m.user_id, m.memory_type, m.content, m.summary, m.importance,
        m.created_by, m.source, m.supersedes, m.external_id,
        m.valid_from, m.valid_until, m.created_at, m.updated_at, m.expires_at,
        m.access_count, m.last_accessed_at, m.deleted_at,
        m.group_id, m.sequence, m.group_type,
        (SELECT COALESCE(json_agg(mt2.tag ORDER BY mt2.tag) FILTER (WHERE mt2.tag IS NOT NULL), '[]'::json)::text
         FROM memory_tags mt2
         WHERE mt2.memory_id = m.id AND mt2.repository_id = m.repository_id) AS _tags
      ${from ?? sql`FROM memories m`}
      JOIN repositories r ON r.id = m.repository_id
      ${extraJoin ?? sql``}
    `;
  }

  private async addTags(memory: Memory): Promise<Memory> {
    return { ...memory, tags: await this.getTagsForMemory(memory.id, memory.repository_id) };
  }

  private parseTags(row: Memory & { _tags?: string | null }): Memory {
    const { _tags, ...memory } = row;
    return { ...memory, tags: parseJsonTags(_tags) };
  }

  private toRecallResult(row: SearchRow, matchType: "fts" | "semantic"): RecallResult {
    const parsed = this.parseTags(row);
    return {
      ...parsed,
      score: typeof row.score === "number" ? row.score : Number(row.score) || 0,
      match_type: matchType,
    };
  }
}

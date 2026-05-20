import { randomUUID } from "node:crypto";
import { getDb, type LocalDatabase } from "../db/connection.js";
import { DatabaseError, dbQuery } from "../errors.js";
import type { RepositoryIdentity } from "../services/git-identity.service.js";
import type { Memory, MemoryStats, MemoryType, RecallResult, RepositoryRecord } from "../types/memory.js";

export type SqlProvider = () => LocalDatabase;

type SqlParam = string | number | bigint | Buffer | null;

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

interface MemoryRow extends Omit<Memory, "tags"> {
  pk: number;
  _tags?: string | null;
}

interface RepositoryRow extends Omit<RepositoryRecord, "metadata"> {
  pk: number;
  metadata: string | null;
}

interface SearchRow extends MemoryRow {
  score: number;
}

function nowIso(): string {
  return new Date().toISOString();
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function jsonText(value: unknown): string {
  return JSON.stringify(value ?? {});
}

function parseObject(raw: unknown): Record<string, string | number | boolean | null> {
  if (!raw) return {};
  if (typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, string | number | boolean | null>;
  if (typeof raw !== "string") return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, string | number | boolean | null>)
      : {};
  } catch {
    return {};
  }
}

export function parseJsonTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  try {
    const parsed = JSON.parse(tags) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string" && tag.length > 0)
      : [];
  } catch {
    return [];
  }
}

function cleanTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0 && !tag.startsWith("repo:")))].slice(
    0,
    100,
  );
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function activeClause(alias = "m"): string {
  return `${alias}.deleted_at IS NULL AND ${alias}.valid_until IS NULL AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`;
}

function ftsQuery(input: string): string | null {
  const terms = input
    .split(/[^\p{L}\p{N}_./:-]+/u)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 20);
  if (terms.length === 0) return null;
  return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
}

function memorySelect(extra = ""): string {
  return `
    SELECT
      ${extra}
      m.pk, m.id, m.repository_id, r.slug AS repository_slug, r.name AS repository_name,
      m.user_id, m.memory_type, m.content, m.summary, m.importance,
      m.created_by, m.source, m.supersedes, m.external_id,
      m.valid_from, m.valid_until, m.created_at, m.updated_at, m.expires_at,
      m.access_count, m.last_accessed_at, m.deleted_at,
      m.group_id, m.sequence, m.group_type,
      COALESCE((
        SELECT json_group_array(tag)
        FROM (
          SELECT mt2.tag AS tag
          FROM memory_tags mt2
          WHERE mt2.memory_id = m.id AND mt2.repository_id = m.repository_id
          ORDER BY mt2.tag
        )
      ), '[]') AS _tags
    FROM memories m
    JOIN repositories r ON r.id = m.repository_id
  `;
}

function toRepository(row: RepositoryRow): RepositoryRecord {
  const { pk: _pk, metadata, ...rest } = row;
  return { ...rest, metadata: parseObject(metadata) };
}

function toMemory(row: MemoryRow): Memory {
  const { pk: _pk, _tags, ...memory } = row;
  return {
    ...memory,
    tags: parseJsonTags(_tags),
    valid_from: new Date(memory.valid_from),
    valid_until: memory.valid_until ? new Date(memory.valid_until) : null,
    created_at: new Date(memory.created_at),
    updated_at: new Date(memory.updated_at),
    expires_at: memory.expires_at ? new Date(memory.expires_at) : null,
    last_accessed_at: new Date(memory.last_accessed_at),
    deleted_at: memory.deleted_at ? new Date(memory.deleted_at) : null,
  };
}

function vectorText(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
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
      const db = this.getSql();
      const current = db.get<RepositoryRow>("SELECT * FROM repositories WHERE root_hash = ? LIMIT 1", [
        identity.repository_root_hash,
      ]);
      if (current) {
        const metadata = { ...parseObject(current.metadata), identity_kind: identity.repository_identity_kind };
        db.run(
          `UPDATE repositories
           SET name = ?, root_path = ?, remote_url_hash = ?, metadata = ?, last_seen_at = ?, updated_at = ?
           WHERE id = ?`,
          [
            identity.repository_name,
            identity.repository_root,
            identity.repository_remote_url_hash ?? null,
            jsonText(metadata),
            nowIso(),
            nowIso(),
            current.id,
          ],
        );
        const row = db.get<RepositoryRow>("SELECT * FROM repositories WHERE id = ?", [current.id]);
        if (!row) throw new DatabaseError("Failed to update repository identity");
        return toRepository(row);
      }

      const slugTaken = db.get<{ id: string }>("SELECT id FROM repositories WHERE slug = ? LIMIT 1", [
        identity.repository_slug,
      ]);
      const slug = slugTaken
        ? `${identity.repository_slug}-${identity.repository_root_hash.slice(0, 8)}`
        : identity.repository_slug;
      const id = randomUUID();
      db.run(
        `INSERT INTO repositories (id, slug, name, root_path, root_hash, remote_url_hash, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          slug,
          identity.repository_name,
          identity.repository_root,
          identity.repository_root_hash,
          identity.repository_remote_url_hash ?? null,
          jsonText({ identity_kind: identity.repository_identity_kind }),
        ],
      );
      const row = db.get<RepositoryRow>("SELECT * FROM repositories WHERE id = ?", [id]);
      if (!row) throw new DatabaseError("Failed to create repository");
      return toRepository(row);
    });
  }

  async findRepository(identifier: string): Promise<RepositoryRecord | null> {
    const row = this.getSql().get<RepositoryRow>("SELECT * FROM repositories WHERE id = ? OR slug = ? LIMIT 1", [
      identifier,
      identifier,
    ]);
    return row ? toRepository(row) : null;
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    const rows = this.getSql().all<RepositoryRow & { memory_count: number }>(
      `SELECT r.*,
        COUNT(m.id) AS memory_count
       FROM repositories r
       LEFT JOIN memories m
         ON m.repository_id = r.id
        AND ${activeClause("m")}
       GROUP BY r.id
       ORDER BY memory_count DESC, r.slug ASC`,
      [nowIso()],
    );
    return rows.map(toRepository);
  }

  async create(data: CreateMemoryRow): Promise<Memory> {
    return dbQuery("MemoryRepository.create", async () => {
      const db = this.getSql();
      const id = data.id ?? randomUUID();
      const timestamp = nowIso();
      db.run(
        `INSERT INTO memories (
          id, repository_id, user_id, memory_type, content, summary, importance, created_by, source, supersedes,
          external_id, valid_from, valid_until, last_accessed_at, created_at, updated_at, expires_at,
          group_id, sequence, group_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          id,
          data.repository_id,
          data.user_id,
          data.memory_type,
          data.content,
          data.summary,
          data.importance,
          data.created_by,
          data.source,
          data.supersedes,
          data.external_id ?? null,
          iso(data.valid_from) ?? timestamp,
          iso(data.valid_until),
          timestamp,
          iso(data.created_at) ?? timestamp,
          iso(data.updated_at) ?? timestamp,
          iso(data.expires_at),
          data.group_id ?? null,
          data.sequence ?? null,
          data.group_type ?? null,
        ],
      );
      if (data.embedding) this.setEmbedding(id, data.repository_id, data.embedding);
      const row = await this.findById(id, data.repository_id, { activeOnly: false });
      if (!row) throw new DatabaseError("INSERT INTO memories did not return a row");
      return row;
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
      const db = this.getSql();
      const current = db.get<{ repository_id: string }>(
        `SELECT repository_id FROM memories WHERE id = ? AND deleted_at IS NULL ${repositoryId ? "AND repository_id = ?" : ""}`,
        repositoryId ? [id, repositoryId] : [id],
      );
      if (!current) return null;
      db.run(
        `UPDATE memories SET
           content = COALESCE(?, content),
           summary = COALESCE(?, summary),
           importance = COALESCE(?, importance),
           memory_type = COALESCE(?, memory_type),
           valid_until = CASE WHEN ? = 1 THEN ? ELSE valid_until END,
           supersedes = CASE WHEN ? = 1 THEN ? ELSE supersedes END,
           updated_at = ?
         WHERE id = ? AND deleted_at IS NULL ${repositoryId ? "AND repository_id = ?" : ""}`,
        [
          data.content ?? null,
          data.summary ?? null,
          data.importance ?? null,
          data.memory_type ?? null,
          data.valid_until !== undefined ? 1 : 0,
          iso(data.valid_until),
          data.supersedes !== undefined ? 1 : 0,
          data.supersedes ?? null,
          nowIso(),
          id,
          ...(repositoryId ? [repositoryId] : []),
        ],
      );
      if (data.embedding !== undefined) this.setEmbedding(id, current.repository_id, data.embedding);
      return this.findById(id, current.repository_id, { activeOnly: false });
    });
  }

  async findById(id: string, repositoryId?: string, options?: { activeOnly?: boolean }): Promise<Memory | null> {
    return dbQuery(`MemoryRepository.findById(${id})`, async () => {
      const params: SqlParam[] = [id];
      const conditions = ["m.id = ?", "m.deleted_at IS NULL"];
      if (options?.activeOnly) conditions.push("m.valid_until IS NULL");
      if (repositoryId) {
        conditions.push("m.repository_id = ?");
        params.push(repositoryId);
      }
      const row = this.getSql().get<MemoryRow>(`${memorySelect()} WHERE ${conditions.join(" AND ")}`, params);
      if (!row) return null;
      if (row.expires_at && new Date(row.expires_at) <= new Date()) {
        await this.softDelete(id, repositoryId);
        return null;
      }
      return toMemory(row);
    });
  }

  async findByExternalId(repositoryId: string, externalId: string): Promise<Memory | null> {
    const row = this.getSql().get<MemoryRow>(
      `${memorySelect()}
       WHERE m.repository_id = ? AND m.external_id = ? AND m.deleted_at IS NULL
       LIMIT 1`,
      [repositoryId, externalId],
    );
    return row ? toMemory(row) : null;
  }

  async softDelete(id: string, repositoryId?: string): Promise<boolean> {
    const result = this.getSql().run(
      `UPDATE memories
       SET deleted_at = ?, valid_until = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL ${repositoryId ? "AND repository_id = ?" : ""}`,
      repositoryId ? [nowIso(), nowIso(), nowIso(), id, repositoryId] : [nowIso(), nowIso(), nowIso(), id],
    );
    return result.changes > 0;
  }

  async invalidate(id: string, repositoryId?: string): Promise<boolean> {
    const result = this.getSql().run(
      `UPDATE memories
       SET valid_until = ?, updated_at = ?
       WHERE id = ? AND deleted_at IS NULL AND valid_until IS NULL ${repositoryId ? "AND repository_id = ?" : ""}`,
      repositoryId ? [nowIso(), nowIso(), id, repositoryId] : [nowIso(), nowIso(), id],
    );
    return result.changes > 0;
  }

  async list(filters: MemoryListFilters): Promise<Memory[]> {
    return dbQuery("MemoryRepository.list", async () => {
      const { where, params } = this.listWhere(filters);
      const rows = this.getSql().all<MemoryRow>(
        `${memorySelect()}
         ${where}
         ORDER BY m.updated_at DESC
         LIMIT ? OFFSET ?`,
        [...params, filters.limit, filters.offset],
      );
      return rows.map(toMemory);
    });
  }

  async searchFts(query: string, filters: SearchFilters, limit: number): Promise<RecallResult[]> {
    return dbQuery("MemoryRepository.searchFts", async () => {
      const match = ftsQuery(query);
      if (!match) return [];
      const { where, params } = this.searchWhere(filters, "ranked");
      const rows = this.getSql().all<SearchRow>(
        `WITH ranked AS (
           SELECT rowid AS pk, -bm25(memories_fts) AS score
           FROM memories_fts
           WHERE memories_fts MATCH ?
         )
         ${memorySelect("ranked.score AS score,")}
         JOIN ranked ON ranked.pk = m.pk
         ${where}
         ORDER BY ranked.score DESC, m.updated_at DESC
         LIMIT ?`,
        [match, ...params, limit],
      );
      return rows.map((row) => this.toRecallResult(row, "fts"));
    });
  }

  async searchSemantic(embedding: number[], filters: SearchFilters, limit: number): Promise<RecallResult[]> {
    return dbQuery("MemoryRepository.searchSemantic", async () => {
      const db = this.getSql();
      const repository = filters.repository_id
        ? db.get<{ pk: number }>("SELECT pk FROM repositories WHERE id = ?", [filters.repository_id])
        : undefined;
      const rankedParams: SqlParam[] = [vectorText(embedding), limit * 3];
      const partition = repository ? "AND repository_pk = ?" : "";
      if (repository) rankedParams.push(BigInt(repository.pk));
      const { where, params } = this.searchWhere(filters, "ranked");
      const rows = db.all<SearchRow>(
        `WITH ranked AS (
           SELECT memory_pk, 1 - distance AS score
           FROM memory_vectors
           WHERE embedding MATCH ? AND k = ? ${partition}
         )
         ${memorySelect("ranked.score AS score,")}
         JOIN ranked ON ranked.memory_pk = m.pk
         ${where}
         ORDER BY ranked.score DESC
         LIMIT ?`,
        [...rankedParams, ...params, limit],
      );
      return rows.map((row) => this.toRecallResult(row, "semantic"));
    });
  }

  async findSimilar(
    embedding: number[],
    threshold: number,
    limit = 5,
    repositoryId?: string,
    excludeId?: string,
  ): Promise<{ id: string; similarity: number; content: string; summary: string }[]> {
    const filters: SearchFilters = repositoryId ? { repository_id: repositoryId } : {};
    const semantic = await this.searchSemantic(embedding, filters, limit * 2);
    return semantic
      .filter((row) => row.id !== excludeId && row.score > threshold)
      .slice(0, limit)
      .map((row) => ({ id: row.id, similarity: row.score, content: row.content, summary: row.summary }));
  }

  async findByGroupId(
    repositoryId: string | undefined,
    groupId: string,
    options?: { sequence?: number; seqMin?: number; seqMax?: number; limit?: number },
  ): Promise<Memory[]> {
    const params: SqlParam[] = [nowIso(), groupId];
    const conditions = [activeClause("m"), "m.group_id = ?"];
    if (repositoryId) {
      conditions.push("m.repository_id = ?");
      params.push(repositoryId);
    }
    if (options?.sequence !== undefined) {
      conditions.push("m.sequence = ?");
      params.push(options.sequence);
    }
    if (options?.seqMin !== undefined && options.seqMax !== undefined) {
      conditions.push("m.sequence >= ? AND m.sequence <= ?");
      params.push(options.seqMin, options.seqMax);
    }
    const rows = this.getSql().all<MemoryRow>(
      `${memorySelect()}
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.sequence ASC NULLS LAST
       LIMIT ?`,
      [...params, options?.limit ?? 100],
    );
    return rows.map(toMemory);
  }

  async batchUpdateAccessStats(ids: string[], repositoryId?: string): Promise<void> {
    if (ids.length === 0) return;
    const params: SqlParam[] = [nowIso(), ...ids];
    let sql = `UPDATE memories
       SET access_count = access_count + 1, last_accessed_at = ?
       WHERE id IN (${placeholders(ids)}) AND deleted_at IS NULL`;
    if (repositoryId) {
      sql += " AND repository_id = ?";
      params.push(repositoryId);
    }
    this.getSql().run(sql, params);
  }

  async setTags(memoryId: string, tags: string[], repositoryId: string): Promise<void> {
    const db = this.getSql();
    const safeTags = cleanTags(tags);
    db.run("DELETE FROM memory_tags WHERE memory_id = ?", [memoryId]);
    for (const tag of safeTags) {
      db.run(
        `INSERT INTO memory_tags (memory_id, repository_id, tag)
         VALUES (?, ?, ?)
         ON CONFLICT(memory_id, tag) DO NOTHING`,
        [memoryId, repositoryId, tag],
      );
    }
  }

  async getTagsForMemory(memoryId: string, repositoryId?: string): Promise<string[]> {
    const rows = this.getSql().all<{ tag: string }>(
      `SELECT tag FROM memory_tags WHERE memory_id = ? ${repositoryId ? "AND repository_id = ?" : ""} ORDER BY tag`,
      repositoryId ? [memoryId, repositoryId] : [memoryId],
    );
    return rows.map((row) => row.tag);
  }

  async getAllTags(repositoryId?: string): Promise<{ tag: string; count: number }[]> {
    return this.getSql().all<{ tag: string; count: number }>(
      `SELECT mt.tag, COUNT(*) AS count
       FROM memory_tags mt
       JOIN memories m ON m.id = mt.memory_id
       WHERE ${activeClause("m")} ${repositoryId ? "AND mt.repository_id = ?" : ""}
       GROUP BY mt.tag
       ORDER BY count DESC, mt.tag ASC
       LIMIT 500`,
      repositoryId ? [nowIso(), repositoryId] : [nowIso()],
    );
  }

  async getStats(repositoryId?: string): Promise<MemoryStats> {
    const db = this.getSql();
    const repoParams: SqlParam[] = [nowIso()];
    const repoFilter = repositoryId ? "AND m.repository_id = ?" : "";
    if (repositoryId) repoParams.push(repositoryId);
    const repository = repositoryId
      ? db.get<RepositoryRow>("SELECT * FROM repositories WHERE id = ?", [repositoryId])
      : undefined;
    const totalRow = db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memories m WHERE ${activeClause("m")} ${repoFilter}`,
      repoParams,
    );
    const typeRows = db.all<{ memory_type: string; count: number }>(
      `SELECT m.memory_type, COUNT(*) AS count
       FROM memories m
       WHERE ${activeClause("m")} ${repoFilter}
       GROUP BY m.memory_type`,
      repoParams,
    );
    const repositoryRows = db.all<{ slug: string; count: number }>(
      `SELECT r.slug, COUNT(m.id) AS count
       FROM repositories r
       LEFT JOIN memories m
         ON m.repository_id = r.id
        AND ${activeClause("m")}
       ${repositoryId ? "WHERE r.id = ?" : ""}
       GROUP BY r.slug
       ORDER BY count DESC, r.slug ASC`,
      repositoryId ? [nowIso(), repositoryId] : [nowIso()],
    );
    const recentRows = db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memories m
       WHERE ${activeClause("m")} AND m.created_at >= ? ${repoFilter}`,
      [nowIso(), new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(), ...(repositoryId ? [repositoryId] : [])],
    );
    const staleRows = db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM memories m
       WHERE ${activeClause("m")} AND m.last_accessed_at < ? ${repoFilter}`,
      [
        nowIso(),
        new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString(),
        ...(repositoryId ? [repositoryId] : []),
      ],
    );
    const avgRows = db.get<{ avg: number }>(
      `SELECT COALESCE(AVG(m.importance), 0) AS avg FROM memories m WHERE ${activeClause("m")} ${repoFilter}`,
      repoParams,
    );
    const mostAccessed = this.listMostAccessed(repositoryId);
    const topTags = await this.getAllTags(repositoryId);
    return {
      repository: repository ? toRepository(repository) : null,
      total: totalRow?.count ?? 0,
      by_type: Object.fromEntries(typeRows.map((row) => [row.memory_type, row.count])),
      by_repository: Object.fromEntries(repositoryRows.map((row) => [row.slug, row.count])),
      top_tags: topTags.slice(0, 30),
      most_accessed: mostAccessed,
      recent_count: recentRows?.count ?? 0,
      stale_count: staleRows?.count ?? 0,
      avg_importance: avgRows?.avg ?? 0,
    };
  }

  async findActiveByIds(ids: string[], repositoryId?: string): Promise<Memory[]> {
    if (ids.length === 0) return [];
    const params: SqlParam[] = [nowIso(), ...ids];
    let sql = `${memorySelect()} WHERE ${activeClause("m")} AND m.id IN (${placeholders(ids)})`;
    if (repositoryId) {
      sql += " AND m.repository_id = ?";
      params.push(repositoryId);
    }
    return this.getSql().all<MemoryRow>(sql, params).map(toMemory);
  }

  private listMostAccessed(repositoryId?: string): Memory[] {
    const params: SqlParam[] = [nowIso()];
    const conditions = [activeClause("m")];
    if (repositoryId) {
      conditions.push("m.repository_id = ?");
      params.push(repositoryId);
    }
    return this.getSql()
      .all<MemoryRow>(
        `${memorySelect()}
         WHERE ${conditions.join(" AND ")}
         ORDER BY m.access_count DESC, m.last_accessed_at DESC, m.updated_at DESC
         LIMIT 10`,
        params,
      )
      .map(toMemory);
  }

  async listForReembedding(limit = 100, nullOnly = false, repositoryId?: string): Promise<Memory[]> {
    const params: SqlParam[] = [nowIso()];
    const conditions = [activeClause("m")];
    if (repositoryId) {
      conditions.push("m.repository_id = ?");
      params.push(repositoryId);
    }
    if (nullOnly) conditions.push("NOT EXISTS (SELECT 1 FROM memory_vectors mv WHERE mv.memory_pk = m.pk)");
    const rows = this.getSql().all<MemoryRow>(
      `${memorySelect()}
       WHERE ${conditions.join(" AND ")}
       ORDER BY m.updated_at ASC
       LIMIT ?`,
      [...params, limit],
    );
    return rows.map(toMemory);
  }

  purgeByUser(userId: string, repositoryId?: string): { deleted: number; audit_rows: number } {
    const db = this.getSql();
    const repoFilter = repositoryId ? "AND repository_id = ?" : "";
    const params = repositoryId ? [userId, repositoryId] : [userId];
    const audit = db.run(
      `DELETE FROM audit_log
       WHERE memory_id IN (SELECT id FROM memories WHERE user_id = ? ${repoFilter})`,
      params,
    );
    const deleted = db.run(`DELETE FROM memories WHERE user_id = ? ${repoFilter}`, params);
    return { deleted: deleted.changes, audit_rows: audit.changes };
  }

  upsertBlock(
    repositoryId: string,
    name: string,
    content: string,
    maxTokens: number,
  ): { name: string; content: string; max_tokens: number; repository_id: string; updated_at: Date } {
    const id = randomUUID();
    this.getSql().run(
      `INSERT INTO memory_blocks (id, repository_id, name, content, max_tokens)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repository_id, name)
       DO UPDATE SET content = excluded.content, max_tokens = excluded.max_tokens, updated_at = ?`,
      [id, repositoryId, name, content, maxTokens, nowIso()],
    );
    const row = this.getSql().get<{
      name: string;
      content: string;
      max_tokens: number;
      repository_id: string;
      updated_at: string;
    }>(
      `SELECT name, content, max_tokens, repository_id, updated_at
       FROM memory_blocks WHERE repository_id = ? AND name = ?`,
      [repositoryId, name],
    );
    if (!row) throw new DatabaseError("Failed to update memory block");
    return { ...row, updated_at: new Date(row.updated_at) };
  }

  listBlocks(repositoryId: string): { name: string; content: string; max_tokens: number; repository_id: string }[] {
    return this.getSql().all<{ name: string; content: string; max_tokens: number; repository_id: string }>(
      `SELECT name, content, max_tokens, repository_id
       FROM memory_blocks
       WHERE repository_id = ?
       ORDER BY name`,
      [repositoryId],
    );
  }

  deleteBlock(repositoryId: string, name: string): boolean {
    return (
      this.getSql().run("DELETE FROM memory_blocks WHERE repository_id = ? AND name = ?", [repositoryId, name])
        .changes > 0
    );
  }

  adminAnalytics(days: number): {
    total_memories: number;
    created_last_period: number;
    days: number;
    by_type: Record<string, number>;
    by_repository: Record<string, number>;
    by_creator: { creator: string; repository: string; count: number }[];
    total_tags: number;
    stale_memories: number;
    avg_importance: number;
  } {
    const db = this.getSql();
    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const staleDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
    const totalRow = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL AND valid_until IS NULL",
    );
    const typeRows = db.all<{ memory_type: string; count: number }>(
      `SELECT memory_type, COUNT(*) AS count
       FROM memories
       WHERE deleted_at IS NULL AND valid_until IS NULL
       GROUP BY memory_type ORDER BY count DESC`,
    );
    const repositoryRows = db.all<{ slug: string; count: number }>(
      `SELECT r.slug, COUNT(m.id) AS count
       FROM repositories r
       LEFT JOIN memories m ON m.repository_id = r.id AND m.deleted_at IS NULL AND m.valid_until IS NULL
       GROUP BY r.slug ORDER BY count DESC`,
    );
    const creatorRows = db.all<{ creator: string; repository: string; count: number }>(
      `SELECT m.created_by AS creator, r.slug AS repository, COUNT(*) AS count
       FROM memories m
       JOIN repositories r ON r.id = m.repository_id
       WHERE m.deleted_at IS NULL AND m.valid_until IS NULL
       GROUP BY m.created_by, r.slug ORDER BY count DESC LIMIT 20`,
    );
    const tagRow = db.get<{ count: number }>("SELECT COUNT(DISTINCT tag) AS count FROM memory_tags");
    const staleRow = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL AND valid_until IS NULL AND updated_at < ?",
      [staleDate],
    );
    const importanceRow = db.get<{ avg: number }>(
      "SELECT COALESCE(AVG(importance), 0) AS avg FROM memories WHERE deleted_at IS NULL AND valid_until IS NULL",
    );
    const recentRow = db.get<{ count: number }>(
      "SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL AND valid_until IS NULL AND created_at >= ?",
      [sinceDate],
    );
    return {
      total_memories: totalRow?.count ?? 0,
      created_last_period: recentRow?.count ?? 0,
      days,
      by_type: Object.fromEntries(typeRows.map((row) => [row.memory_type, row.count])),
      by_repository: Object.fromEntries(repositoryRows.map((row) => [row.slug, row.count])),
      by_creator: creatorRows,
      total_tags: tagRow?.count ?? 0,
      stale_memories: staleRow?.count ?? 0,
      avg_importance: importanceRow?.avg ?? 0,
    };
  }

  adminListMemories(filters: {
    limit: number;
    offset: number;
    search?: string;
    memoryType?: string;
    repository?: string;
  }): { total: number; memories: unknown[]; limit: number; offset: number } {
    const params: SqlParam[] = [];
    const match = filters.search?.trim() ? ftsQuery(filters.search) : null;
    if (filters.search?.trim() && !match) {
      return { total: 0, memories: [], limit: filters.limit, offset: filters.offset };
    }
    const conditions = ["m.deleted_at IS NULL", "m.valid_until IS NULL"];
    if (match) {
      conditions.push("memories_fts MATCH ?");
      params.push(match);
    }
    if (filters.memoryType) {
      conditions.push("m.memory_type = ?");
      params.push(filters.memoryType);
    }
    if (filters.repository) {
      conditions.push("r.slug = ?");
      params.push(filters.repository);
    }
    const where = `WHERE ${conditions.join(" AND ")}`;
    const from = match
      ? `FROM memories_fts
         JOIN memories m ON m.pk = memories_fts.rowid
         JOIN repositories r ON r.id = m.repository_id`
      : `FROM memories m
         JOIN repositories r ON r.id = m.repository_id`;
    const orderBy = match ? "ORDER BY bm25(memories_fts), m.updated_at DESC" : "ORDER BY m.updated_at DESC";
    const countRow = this.getSql().get<{ count: number }>(
      `SELECT COUNT(*) AS count
       ${from}
       ${where}`,
      params,
    );
    const memories = this.getSql().all(
      `SELECT m.id, m.summary, m.memory_type, r.slug AS repository,
              m.user_id, m.created_by, m.importance, m.access_count,
              m.created_at, m.updated_at
       ${from}
       ${where}
       ${orderBy}
       LIMIT ? OFFSET ?`,
      [...params, filters.limit, filters.offset],
    );
    return { total: countRow?.count ?? 0, memories, limit: filters.limit, offset: filters.offset };
  }

  adminMemoryDetail(id: string): (Memory & { has_embedding: boolean }) | null {
    const row = this.getSql().get<MemoryRow & { has_embedding: number }>(
      `${memorySelect("EXISTS(SELECT 1 FROM memory_vectors mv WHERE mv.memory_pk = m.pk) AS has_embedding,")}
       WHERE m.id = ?`,
      [id],
    );
    return row ? { ...toMemory(row), has_embedding: Boolean(row.has_embedding) } : null;
  }

  private listWhere(filters: MemoryListFilters): { where: string; params: SqlParam[] } {
    const params: SqlParam[] = [nowIso()];
    const conditions = [activeClause("m")];
    if (filters.repository_id) {
      conditions.push("m.repository_id = ?");
      params.push(filters.repository_id);
    }
    if (filters.user_id) {
      conditions.push("m.user_id = ?");
      params.push(filters.user_id);
    }
    if (filters.memory_type) {
      conditions.push("m.memory_type = ?");
      params.push(filters.memory_type);
    }
    if (filters.since) {
      conditions.push("m.created_at >= ?");
      params.push(filters.since);
    }
    this.applyTagFilter(conditions, params, filters.tags);
    return { where: `WHERE ${conditions.join(" AND ")}`, params };
  }

  private searchWhere(filters: SearchFilters, _rankAlias: string): { where: string; params: SqlParam[] } {
    const params: SqlParam[] = [nowIso()];
    const conditions = [activeClause("m")];
    if (filters.repository_id) {
      conditions.push("m.repository_id = ?");
      params.push(filters.repository_id);
    }
    if (filters.memory_type) {
      conditions.push("m.memory_type = ?");
      params.push(filters.memory_type);
    }
    this.applyTagFilter(conditions, params, filters.tags);
    return { where: `WHERE ${conditions.join(" AND ")}`, params };
  }

  private applyTagFilter(conditions: string[], params: SqlParam[], tags?: string[]): void {
    if (!tags?.length) return;
    conditions.push(`EXISTS (
      SELECT 1 FROM memory_tags mt
      WHERE mt.memory_id = m.id
        AND mt.repository_id = m.repository_id
        AND mt.tag IN (${placeholders(tags)})
    )`);
    params.push(...tags);
  }

  private setEmbedding(memoryId: string, repositoryId: string, embedding: number[] | null): void {
    const db = this.getSql();
    const row = db.get<{ memory_pk: number; repository_pk: number }>(
      `SELECT m.pk AS memory_pk, r.pk AS repository_pk
       FROM memories m
       JOIN repositories r ON r.id = m.repository_id
       WHERE m.id = ? AND m.repository_id = ?`,
      [memoryId, repositoryId],
    );
    if (!row) return;
    db.run("DELETE FROM memory_vectors WHERE memory_pk = ?", [row.memory_pk]);
    if (!embedding) return;
    db.run("INSERT INTO memory_vectors(memory_pk, repository_pk, embedding) VALUES (?, ?, ?)", [
      BigInt(row.memory_pk),
      BigInt(row.repository_pk),
      vectorText(embedding),
    ]);
  }

  private toRecallResult(row: SearchRow, matchType: "fts" | "semantic"): RecallResult {
    const memory = toMemory(row);
    return {
      ...memory,
      score: row.score || 0,
      match_type: matchType,
    };
  }
}

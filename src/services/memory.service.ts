import { getDb, withTransaction } from "../db/connection.js";
import { ValidationError } from "../errors.js";
import { getRequestContextOrDefault, getSamplingService } from "../context.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import { AuditRepository as DefaultAuditRepository } from "../repositories/audit.repository.js";
import { EntityRepository, type EntityType } from "../repositories/entity.repository.js";
import { MemoryRepository } from "../repositories/memory.repository.js";
import { RelationRepository } from "../repositories/relation.repository.js";
import type {
  CorrectInput,
  ForgetInput,
  GraphMode,
  GetContextForInput,
  ListMemoriesInput,
  Memory,
  MemoryStats,
  MemoryType,
  RelatedMode,
  RecallInput,
  RelationType,
  RememberDecisionInput,
  RememberFactInput,
  RememberInput,
  RepositoryRecord,
  RepositorySelector,
  SearchMemoriesInput,
} from "../types/memory.js";
import type { ScoredMemory, TokenBudgetResult } from "../types/scoring.js";
import { DedupService } from "./dedup.service.js";
import { EmbeddingQueue } from "./embedding-queue.js";
import type { EmbeddingPurpose } from "./embedding.service.js";
import { getEmbeddingProvider } from "./embedding.service.js";
import { EntityExtractionService } from "./entity-extraction.service.js";
import { logger } from "./logger.js";
import { compositeScore, generateSummary, scoreImportance, tokenBudget } from "./scoring.service.js";

export interface MemoryServiceDeps {
  memories?: MemoryRepository;
  relations?: RelationRepository;
  audit?: AuditRepository;
  entities?: EntityRepository;
  dedup?: DedupService;
  embeddingQueue?: EmbeddingQueue | undefined;
  asyncEmbedding?: boolean | undefined;
}

export class MemoryService {
  private memories: MemoryRepository;
  private relations: RelationRepository;
  private audit: AuditRepository;
  private entities: EntityRepository;
  private dedup: DedupService;
  private entityExtraction: EntityExtractionService;
  private embeddingQueue?: EmbeddingQueue | undefined;
  private asyncEmbedding: boolean;

  constructor(deps?: MemoryServiceDeps) {
    this.memories = deps?.memories ?? new MemoryRepository();
    this.relations = deps?.relations ?? new RelationRepository();
    this.audit = deps?.audit ?? new DefaultAuditRepository();
    this.entities = deps?.entities ?? new EntityRepository();
    this.dedup = deps?.dedup ?? new DedupService(this.memories);
    this.entityExtraction = new EntityExtractionService(this.entities);
    this.embeddingQueue = deps?.embeddingQueue;
    this.asyncEmbedding = deps?.asyncEmbedding ?? false;
    if (this.embeddingQueue) {
      this.embeddingQueue.onEmbeddingReady = async (memoryId, embedding) => {
        await this.handlePostEmbeddingDedup(memoryId, embedding);
      };
    }
  }

  async flushSync(): Promise<void> {
    return Promise.resolve();
  }

  async currentRepository(): Promise<RepositoryRecord> {
    const ctx = getRequestContextOrDefault();
    return this.memories.ensureRepository(ctx.repository);
  }

  async listRepositories(): Promise<RepositoryRecord[]> {
    return this.memories.listRepositories();
  }

  async resolveRepository(selector?: RepositorySelector): Promise<{
    current: RepositoryRecord | null;
    repository: RepositoryRecord | null;
    repository_id?: string | undefined;
  }> {
    const mode = selector?.repository_mode ?? "current";
    if (mode !== "specific" && selector?.repository) {
      throw new ValidationError("repository is only allowed for repository_mode=specific");
    }
    if (mode === "all") return { current: null, repository: null };
    if (mode === "specific") {
      if (!selector?.repository) throw new ValidationError("repository is required for repository_mode=specific");
      const repository = await this.memories.findRepository(selector.repository);
      if (!repository) throw new ValidationError(`Repository not found: ${selector.repository}`);
      return { current: null, repository, repository_id: repository.id };
    }
    const current = await this.currentRepository();
    return { current, repository: current, repository_id: current.id };
  }

  async remember(input: RememberInput): Promise<Memory & { dedup_action: string }> {
    const repository = await this.currentRepository();
    return this.rememberInRepository(input, repository, null);
  }

  async rememberFact(input: RememberFactInput): Promise<Memory & { dedup_action: string }> {
    return this.remember({
      content: input.fact,
      memory_type: "fact",
      tags: input.tags,
      created_by: input.created_by,
    });
  }

  async rememberDecision(input: RememberDecisionInput): Promise<Memory & { dedup_action: string }> {
    const content = [
      `# Decision: ${input.title}`,
      "",
      "## Context",
      input.context,
      "",
      "## Decision",
      input.decision,
      "",
      "## Rationale",
      input.rationale,
      input.alternatives ? `\n## Alternatives\n${input.alternatives}` : "",
      "",
      `## Date\n${new Date().toISOString().slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join("\n");
    return this.remember({
      content,
      memory_type: "decision",
      tags: ["adr", "decision", ...input.tags],
      created_by: input.created_by,
    });
  }

  async recall(
    input: RecallInput,
  ): Promise<TokenBudgetResult & { query: string; graph_mode: GraphMode; related?: ScoredMemory[] }> {
    const { repository_id } = await this.resolveRepository(input);
    const graphMode = input.graph_mode;
    const textForEmbedding = input.context ? `${input.query}\n\nContext: ${input.context}` : input.query;
    const embedding = await this.generateEmbedding(textForEmbedding, "query");
    const filters = {
      repository_id,
      memory_type: input.memory_type,
      tags: input.tags,
    };
    const fts = await this.memories.searchFts(input.query, filters, input.limit * 3);
    const semantic = embedding ? await this.memories.searchSemantic(embedding, filters, input.limit * 3) : [];
    const scored = compositeScore(fts, semantic).slice(0, input.limit);
    const primaryBudget =
      graphMode === "off" ? input.token_budget : Math.max(100, Math.floor(input.token_budget * 0.9));
    const result = tokenBudget(scored, primaryBudget);

    const returnedIds = result.memories.map((m) => m.id);
    this.memories.batchUpdateAccessStats(returnedIds, repository_id).catch((err: unknown) => {
      logger.debug("Failed to update access stats", { error: err instanceof Error ? err.message : String(err) });
    });

    const relatedBudget = graphMode === "off" ? 0 : Math.max(0, input.token_budget - result.total_tokens);
    const related = await this.graphRelated(
      result.memories,
      repository_id,
      graphMode,
      relatedBudget,
      scored.length,
      input.limit,
    );
    return {
      ...result,
      query: input.query,
      graph_mode: graphMode,
      related: related.memories,
      total_tokens: result.total_tokens + related.total_tokens,
      truncated: result.truncated || related.truncated,
    };
  }

  async getContextFor(input: GetContextForInput): Promise<TokenBudgetResult & { topic: string }> {
    const result = await this.recall({
      query: input.topic,
      repository_mode: input.repository_mode,
      repository: input.repository,
      limit: input.limit,
      token_budget: input.token_budget,
      graph_mode: input.graph_mode ?? this.defaultGraphModeForTopic(input.topic),
    });
    return {
      memories: result.memories,
      total_tokens: result.total_tokens,
      truncated: result.truncated,
      topic: input.topic,
    };
  }

  async getActiveContext(
    tokenBudgetValue = 4000,
    workingOn?: string,
    selector?: RepositorySelector,
  ): Promise<TokenBudgetResult & { repository: RepositoryRecord | null }> {
    const resolved = await this.resolveRepository(selector);
    if (workingOn?.trim()) {
      const result = await this.recall({
        query: workingOn,
        repository_mode: selector?.repository_mode ?? "current",
        repository: selector?.repository,
        limit: 12,
        token_budget: tokenBudgetValue,
        graph_mode: "off",
      });
      return { ...result, repository: resolved.repository };
    }

    const memories = await this.memories.list({
      repository_id: resolved.repository_id,
      memory_type: undefined,
      tags: undefined,
      limit: 50,
      offset: 0,
    });
    const priority = memories
      .filter((m) => ["convention", "decision", "fact", "procedure"].includes(m.memory_type))
      .sort((a, b) => b.importance - a.importance || +new Date(b.updated_at) - +new Date(a.updated_at))
      .slice(0, 12)
      .map((m) => this.toScoredMemory(m));
    return { ...tokenBudget(priority, tokenBudgetValue), repository: resolved.repository };
  }

  async getMemory(
    id: string,
    repositoryId?: string,
    options?: { includeInvalidated?: boolean },
  ): Promise<Memory | null> {
    return this.memories.findById(id, repositoryId, { activeOnly: options?.includeInvalidated !== true });
  }

  async forget(input: ForgetInput, repositoryId?: string): Promise<boolean> {
    const memory = await this.memories.findById(input.id, repositoryId, { activeOnly: true });
    if (!memory) return false;
    const ok = await this.memories.invalidate(input.id, memory.repository_id);
    if (ok) {
      await this.audit.log({
        repository_id: memory.repository_id,
        memory_id: input.id,
        action: "delete",
        actor: input.actor,
        changes: { reason: input.reason ?? null },
      });
    }
    return ok;
  }

  async correct(input: CorrectInput, repositoryId?: string): Promise<Memory | null> {
    const existing = await this.memories.findById(input.id, repositoryId, { activeOnly: true });
    if (!existing) return null;
    const repository = await this.memories.findRepository(existing.repository_id);
    if (!repository) throw new ValidationError("Original memory repository no longer exists");

    const result = await withTransaction(async (tx) => {
      const txMemories = this.memories.withSql(() => tx);
      const txAudit = this.audit.withSql(() => tx);
      const txRelations = this.relations.withSql(() => tx);
      await txMemories.invalidate(existing.id, existing.repository_id);
      const created = await txMemories.create({
        repository_id: existing.repository_id,
        user_id: existing.user_id,
        memory_type: existing.memory_type,
        content: input.new_content,
        summary: generateSummary(input.new_content),
        importance: existing.importance,
        created_by: input.actor,
        source: existing.source,
        supersedes: existing.id,
        external_id: null,
        embedding: await this.generateEmbedding(
          this.buildEmbeddingText(repository, existing.memory_type, existing.tags, input.new_content),
        ),
      });
      await txMemories.setTags(created.id, existing.tags, existing.repository_id);
      await txRelations.create({
        repository_id: existing.repository_id,
        source_id: created.id,
        target_id: existing.id,
        relation_type: "supersedes",
        description: input.reason ?? "Corrected memory supersedes the previous version.",
        origin: "lineage",
        confidence: 1,
        metadata: { source: "correct" },
        requireActiveEndpoints: false,
      });
      await txAudit.log({
        repository_id: existing.repository_id,
        memory_id: created.id,
        action: "create",
        actor: input.actor,
        changes: { corrected: true, supersedes: existing.id, reason: input.reason ?? null },
      });
      return created;
    });

    this.entityExtraction
      .extractAndLink(result.id, input.new_content, existing.repository_id, existing.tags)
      .catch((err: unknown) => {
        logger.debug("Entity extraction failed", { error: err instanceof Error ? err.message : String(err) });
      });
    return result;
  }

  async listMemories(input: ListMemoriesInput): Promise<Memory[]> {
    const { repository_id } = await this.resolveRepository(input);
    return this.memories.list({
      repository_id,
      memory_type: input.memory_type,
      tags: input.tags,
      since: input.since,
      limit: input.limit,
      offset: input.offset,
    });
  }

  async searchMemories(input: SearchMemoriesInput): Promise<ReturnType<typeof compositeScore>> {
    const result = await this.recall({
      query: input.query,
      repository_mode: input.repository_mode,
      repository: input.repository,
      memory_type: input.memory_type,
      tags: input.tags,
      limit: input.limit,
      token_budget: 64000,
      graph_mode: "off",
    });
    return result.memories;
  }

  async getMemoryStats(selector?: RepositorySelector): Promise<MemoryStats> {
    const { repository_id } = await this.resolveRepository(selector);
    return this.memories.getStats(repository_id);
  }

  async linkMemories(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    description?: string,
    repositoryId?: string,
  ) {
    const source = await this.memories.findById(sourceId, repositoryId, { activeOnly: false });
    if (!source) throw new ValidationError("Source memory not found");
    return this.relations.create({
      repository_id: source.repository_id,
      source_id: sourceId,
      target_id: targetId,
      relation_type: relationType,
      description,
      origin: "manual",
      confidence: 1,
      requireActiveEndpoints: true,
    });
  }

  async getRelated(memoryId: string, repositoryId?: string, options?: { mode?: RelatedMode }) {
    const mode = options?.mode ?? "active";
    return this.relations.findByEntry(memoryId, repositoryId, {
      activeOnly: mode !== "all",
      includeLineage: mode === "lineage",
    });
  }

  async getGroupMemories(
    groupId: string,
    repositoryId?: string,
    options?: { sequence?: number; seqMin?: number; seqMax?: number; limit?: number },
  ): Promise<Memory[]> {
    return this.memories.findByGroupId(repositoryId, groupId, options);
  }

  async importMarkdown(markdown: string, userId?: string): Promise<{ imported: number; skipped: number }> {
    const repository = await this.currentRepository();
    const sections = this.parseMarkdownSections(markdown);
    let imported = 0;
    let skipped = 0;
    for (const section of sections) {
      const content = `# ${section.title}\n\n${section.content}`.trim();
      if (!content) {
        skipped++;
        continue;
      }
      await this.rememberInRepository(
        {
          content,
          memory_type: this.inferType(section.title, section.content),
          tags: section.tags,
          created_by: userId ?? "import",
        },
        repository,
        null,
      );
      imported++;
    }
    return { imported, skipped };
  }

  async exportMarkdown(selector?: RepositorySelector): Promise<string> {
    const resolved = await this.resolveRepository(selector);
    const memories = await this.memories.list({ repository_id: resolved.repository_id, limit: 1000, offset: 0 });
    const lines = [
      "# Local Memory Export",
      "",
      `Repository: ${resolved.repository?.slug ?? "all"}`,
      `Generated: ${new Date().toISOString()}`,
      "",
    ];
    for (const memory of memories) {
      lines.push(`## ${memory.summary}`, "");
      lines.push(`**Type:** ${memory.memory_type}`);
      lines.push(`**Repository:** ${memory.repository_slug ?? memory.repository_id}`);
      if (memory.tags.length) lines.push(`**Tags:** ${memory.tags.join(", ")}`);
      lines.push("", memory.content, "");
    }
    return lines.join("\n");
  }

  async getAllTags(selector?: RepositorySelector): Promise<{ tag: string; count: number }[]> {
    const { repository_id } = await this.resolveRepository(selector);
    return this.memories.getAllTags(repository_id);
  }

  async getRecentChanges(limit = 20, selector?: RepositorySelector) {
    const { repository_id } = await this.resolveRepository(selector);
    return this.audit.getRecent(limit, repository_id);
  }

  async consolidate(selector?: RepositorySelector): Promise<{ recalculated: number; errors: number }> {
    const { repository_id } = await this.resolveRepository(selector);
    const memories = await this.memories.list({ repository_id, limit: 1000, offset: 0 });
    let recalculated = 0;
    let errors = 0;
    for (const memory of memories) {
      try {
        const importance = scoreImportance(memory.content, memory.memory_type);
        await this.memories.update(memory.id, { importance }, memory.repository_id);
        recalculated++;
      } catch {
        errors++;
      }
    }
    return { recalculated, errors };
  }

  async digestSession(input: { summary: string; tags?: string[]; created_by?: string }): Promise<{ created: number }> {
    const extracted = this.extractMemoriesFromSummary(input.summary);
    let created = 0;
    for (const memory of extracted) {
      await this.remember({
        content: memory.content,
        memory_type: memory.type,
        tags: [...(input.tags ?? []), ...memory.tags],
        created_by: input.created_by ?? "agent",
      });
      created++;
    }
    return { created };
  }

  async syncConventions(input: { content: string; source: string; tags?: string[] }): Promise<{ imported: number }> {
    const sections = this.parseMarkdownSections(input.content);
    let imported = 0;
    for (const section of sections) {
      await this.remember({
        content: `# ${section.title}\n\n${section.content}`.trim(),
        memory_type: section.title.toLowerCase().includes("decision") ? "decision" : "convention",
        tags: ["convention", `source:${input.source}`, ...section.tags, ...(input.tags ?? [])],
        created_by: "sync_conventions",
      });
      imported++;
    }
    return { imported };
  }

  async exportConventions(selector?: RepositorySelector): Promise<string> {
    const memories = await this.listMemories({
      repository_mode: selector?.repository_mode ?? "current",
      repository: selector?.repository,
      memory_type: "convention",
      limit: 500,
      offset: 0,
    });
    return memories.map((m) => `## ${m.summary}\n\n${m.content}`).join("\n\n");
  }

  async queryEntities(input: {
    query: string;
    entityType?: EntityType;
    limit: number;
    repository_mode?: "current" | "specific" | "all";
    repository?: string;
  }) {
    const { repository_id } = await this.resolveRepository(input);
    if (!repository_id) {
      const repositories = await this.listRepositories();
      const groups = [];
      for (const repository of repositories) {
        groups.push({
          repository: repository.slug,
          entities: await this.entities.searchByName(input.query, repository.id, input.limit, input.entityType),
        });
      }
      return groups;
    }
    const entities = input.query.trim()
      ? await this.entities.searchByName(input.query, repository_id, input.limit, input.entityType)
      : await this.entities.listEntities(repository_id, input.entityType, input.limit);
    return entities;
  }

  async detectConflicts(input: {
    memoryType?: MemoryType;
    limit: number;
    repository_mode?: "current" | "specific" | "all";
    repository?: string;
  }): Promise<{ a: Memory; b: Memory; reason: string }[]> {
    const memories = await this.listMemories({
      repository_mode: input.repository_mode ?? "current",
      repository: input.repository,
      memory_type: input.memoryType,
      limit: Math.min(input.limit * 5, 100),
      offset: 0,
    });
    const conflicts: { a: Memory; b: Memory; reason: string }[] = [];
    for (let i = 0; i < memories.length; i++) {
      const a = memories[i];
      if (!a) continue;
      for (let j = i + 1; j < memories.length; j++) {
        const b = memories[j];
        if (!b) continue;
        if (this.dedup.detectContradiction(a.content, b.content)) {
          conflicts.push({ a, b, reason: "heuristic contradiction" });
          if (conflicts.length >= input.limit) return conflicts;
        }
      }
    }
    return conflicts;
  }

  async purgeUserMemories(
    userId: string,
    selector?: RepositorySelector,
  ): Promise<{ deleted: number; audit_rows: number }> {
    const { repository_id } = await this.resolveRepository(selector);
    const sql = getDb();
    const repositoryFilter = repository_id ? sql`AND repository_id = ${repository_id}` : sql``;
    const auditRows = await sql<{ id: string }[]>`
      DELETE FROM audit_log
      WHERE memory_id IN (SELECT id FROM memories WHERE user_id = ${userId} ${repositoryFilter})
      RETURNING id
    `;
    const rows = await sql<{ id: string }[]>`
      DELETE FROM memories
      WHERE user_id = ${userId} ${repositoryFilter}
      RETURNING id
    `;
    return { deleted: rows.length, audit_rows: auditRows.length };
  }

  async getAnalytics(selector?: RepositorySelector): Promise<MemoryStats> {
    return this.getMemoryStats(selector);
  }

  async reembedMemories(
    batchSize = 100,
    nullOnly = false,
    selector?: RepositorySelector,
  ): Promise<{ processed: number; updated: number; failed: number }> {
    const { repository_id } = await this.resolveRepository(selector);
    const memories = await this.memories.listForReembedding(batchSize, nullOnly, repository_id);
    let updated = 0;
    let failed = 0;
    for (const memory of memories) {
      try {
        const embedding = await this.generateEmbedding(
          this.buildEmbeddingText(
            {
              slug: memory.repository_slug ?? String(memory.repository_id),
              name: memory.repository_name ?? String(memory.repository_id),
            },
            memory.memory_type,
            memory.tags,
            memory.content,
          ),
        );
        await this.memories.update(memory.id, { embedding }, memory.repository_id);
        updated++;
      } catch {
        failed++;
      }
    }
    return { processed: memories.length, updated, failed };
  }

  async updateMemoryBlock(
    name: string,
    content: string,
    maxTokens = 500,
    operation: "replace" | "append" | "prepend" = "replace",
  ): Promise<{ name: string; content: string; max_tokens: number; repository_id: string; updated_at: Date }> {
    const repository = await this.currentRepository();
    const sql = getDb();
    const [existing] = await sql<{ content: string }[]>`
      SELECT content FROM memory_blocks WHERE repository_id = ${repository.id} AND name = ${name}
    `;
    const next =
      operation === "append" && existing
        ? `${existing.content}\n${content}`
        : operation === "prepend" && existing
          ? `${content}\n${existing.content}`
          : content;
    const [row] = await sql<
      { name: string; content: string; max_tokens: number; repository_id: string; updated_at: Date }[]
    >`
      INSERT INTO memory_blocks (id, repository_id, name, content, max_tokens)
      VALUES (gen_random_uuid(), ${repository.id}, ${name}, ${next}, ${maxTokens})
      ON CONFLICT (repository_id, name)
      DO UPDATE SET content = EXCLUDED.content, max_tokens = EXCLUDED.max_tokens, updated_at = now()
      RETURNING name, content, max_tokens, repository_id, updated_at
    `;
    if (!row) throw new ValidationError("Failed to update memory block");
    return row;
  }

  async listMemoryBlocks(): Promise<{ name: string; content: string; max_tokens: number; repository_id: string }[]> {
    const repository = await this.currentRepository();
    const sql = getDb();
    return sql<{ name: string; content: string; max_tokens: number; repository_id: string }[]>`
      SELECT name, content, max_tokens, repository_id
      FROM memory_blocks
      WHERE repository_id = ${repository.id}
      ORDER BY name
    `;
  }

  async deleteMemoryBlock(name: string): Promise<boolean> {
    const repository = await this.currentRepository();
    const sql = getDb();
    const [row] = await sql`
      DELETE FROM memory_blocks WHERE repository_id = ${repository.id} AND name = ${name} RETURNING id
    `;
    return !!row;
  }

  private async rememberInRepository(
    input: RememberInput,
    repository: RepositoryRecord,
    supersedes: string | null,
  ): Promise<Memory & { dedup_action: string }> {
    const ctx = getRequestContextOrDefault();
    const tags = this.cleanTags(input.tags);
    const summary = await this.summarize(input.content);
    const importance = input.importance ?? (await this.calculateImportance(input.content, input.memory_type));
    const expiresAt = input.ttl_days ? new Date(Date.now() + input.ttl_days * 24 * 60 * 60 * 1000) : null;
    const embeddingText = this.buildEmbeddingText(repository, input.memory_type, tags, input.content);
    const embedding = this.asyncEmbedding ? null : await this.generateEmbedding(embeddingText);

    if (input.external_id) {
      const existing = await this.memories.findByExternalId(repository.id, input.external_id);
      if (existing) {
        const updated = await this.memories.update(
          existing.id,
          { content: input.content, summary, importance, memory_type: input.memory_type, embedding },
          repository.id,
        );
        if (!updated) throw new ValidationError("Failed to update memory by external_id");
        await this.memories.setTags(updated.id, tags, repository.id);
        await this.audit.log({
          repository_id: repository.id,
          memory_id: updated.id,
          action: "update",
          actor: input.created_by,
          changes: { external_id: input.external_id },
        });
        const reloaded = await this.memories.findById(updated.id, repository.id);
        if (!reloaded) throw new ValidationError("Updated memory not found");
        return { ...reloaded, dedup_action: "update" };
      }
    }

    const dedup = await this.dedup.findDuplicates(embedding, input.content, undefined, repository.id);
    if (dedup.action === "merge" && dedup.existing_id) {
      const existing = await this.memories.findById(dedup.existing_id, repository.id);
      if (existing) {
        const mergedContent = this.dedup.mergeContent(existing.content, input.content);
        const updated = await this.memories.update(
          existing.id,
          {
            content: mergedContent,
            summary: generateSummary(mergedContent),
            importance: Math.max(existing.importance, importance),
            embedding,
          },
          repository.id,
        );
        if (!updated) throw new ValidationError("Failed to merge memory");
        await this.memories.setTags(updated.id, [...existing.tags, ...tags], repository.id);
        await this.audit.log({
          repository_id: repository.id,
          memory_id: updated.id,
          action: "update",
          actor: input.created_by,
          changes: { dedup_action: "merge", similarity: dedup.similarity ?? null },
        });
        const reloaded = await this.memories.findById(updated.id, repository.id);
        if (!reloaded) throw new ValidationError("Merged memory not found");
        return { ...reloaded, dedup_action: "merge" };
      }
    }

    const existingToSupersede = dedup.action === "supersede" ? dedup.existing_id : null;
    const memory = await this.memories.create({
      repository_id: repository.id,
      user_id: ctx.user_id,
      memory_type: input.memory_type,
      content: input.content,
      summary,
      importance,
      created_by: input.created_by,
      source: input.source ?? null,
      supersedes: supersedes ?? existingToSupersede ?? null,
      external_id: input.external_id ?? null,
      embedding,
      expires_at: expiresAt,
      group_id: input.group_id ?? null,
      sequence: input.sequence ?? null,
      group_type: input.group_type ?? null,
    });
    await this.memories.setTags(memory.id, tags, repository.id);
    if (existingToSupersede) await this.memories.invalidate(existingToSupersede, repository.id);
    if (existingToSupersede) {
      await this.relations.create({
        repository_id: repository.id,
        source_id: memory.id,
        target_id: existingToSupersede,
        relation_type: "supersedes",
        description: "New memory supersedes a duplicate or stale memory.",
        origin: "lineage",
        confidence: 1,
        metadata: { source: "dedup" },
        requireActiveEndpoints: false,
      });
    }
    if (this.asyncEmbedding && this.embeddingQueue) {
      this.embeddingQueue.enqueue(memory.id, embeddingText, "document", repository.id);
    }
    this.entityExtraction.extractAndLink(memory.id, input.content, repository.id, tags).catch((err: unknown) => {
      logger.debug("Entity extraction failed", { error: err instanceof Error ? err.message : String(err) });
    });
    await this.audit.log({
      repository_id: repository.id,
      memory_id: memory.id,
      action: "create",
      actor: input.created_by,
      changes: { memory_type: input.memory_type, dedup_action: existingToSupersede ? "supersede" : "create" },
    });
    const reloaded = await this.memories.findById(memory.id, repository.id);
    if (!reloaded) throw new ValidationError("Created memory not found");
    return { ...reloaded, dedup_action: existingToSupersede ? "supersede" : "create" };
  }

  private async handlePostEmbeddingDedup(memoryId: string, embedding: number[]): Promise<void> {
    const memory = await this.memories.findById(memoryId, undefined, { activeOnly: true });
    if (!memory) return;
    const result = await this.dedup.findDuplicates(
      embedding,
      memory.content,
      undefined,
      memory.repository_id,
      memory.id,
    );
    if (result.action !== "merge" || !result.existing_id) return;
    const existing = await this.memories.findById(result.existing_id, memory.repository_id, { activeOnly: true });
    if (!existing) return;
    const merged = this.dedup.mergeContent(existing.content, memory.content);
    await this.memories.update(
      existing.id,
      { content: merged, summary: generateSummary(merged) },
      memory.repository_id,
    );
    await this.memories.softDelete(memory.id, memory.repository_id);
  }

  private async summarize(content: string): Promise<string> {
    const sampling = getSamplingService();
    if (!sampling) return generateSummary(content);
    try {
      return await sampling.summarize(content);
    } catch {
      return generateSummary(content);
    }
  }

  private async calculateImportance(content: string, type: MemoryType): Promise<number> {
    const sampling = getSamplingService();
    if (!sampling) return scoreImportance(content, type);
    try {
      return await sampling.scoreImportance(content, type);
    } catch {
      return scoreImportance(content, type);
    }
  }

  private async generateEmbedding(text: string, purpose: EmbeddingPurpose = "document"): Promise<number[] | null> {
    try {
      const embedding = await getEmbeddingProvider().embed(text, purpose);
      return embedding.every((value) => value === 0) ? null : embedding;
    } catch (err: unknown) {
      logger.debug("Embedding generation failed", { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }

  private buildEmbeddingText(
    repository: Pick<RepositoryRecord, "slug" | "name">,
    memoryType: MemoryType,
    tags: string[],
    content: string,
  ): string {
    const tagPart = tags.length ? ` tags:${tags.join(",")}` : "";
    return `[repository:${repository.slug}] [type:${memoryType}]${tagPart}\n${content}`;
  }

  private cleanTags(tags: string[]): string[] {
    return [
      ...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0 && !tag.startsWith("repo:"))),
    ].slice(0, 100);
  }

  private async graphRelated(
    memories: ScoredMemory[],
    repositoryId: string | undefined,
    graphMode: GraphMode,
    budget: number,
    totalCandidates: number,
    requestedLimit: number,
  ): Promise<TokenBudgetResult> {
    if (graphMode === "off" || budget <= 0 || memories.length === 0) {
      return { memories: [], total_tokens: 0, truncated: false };
    }
    const hard = await this.hardGraphRelated(memories, repositoryId);
    const useSoft =
      graphMode === "full" ||
      (graphMode === "auto" && (memories.length < Math.min(3, requestedLimit) || totalCandidates < requestedLimit));
    const soft = useSoft && repositoryId ? await this.softGraphRelated(memories, repositoryId, hard) : [];
    return tokenBudget([...hard, ...soft], budget);
  }

  private async hardGraphRelated(memories: ScoredMemory[], repositoryId?: string): Promise<ScoredMemory[]> {
    const seen = new Set(memories.map((m) => m.id));
    const seedIds = memories.slice(0, 5).map((memory) => memory.id);
    const relations = await this.relations.findByEntries(seedIds, repositoryId, { activeOnly: true });
    const relationByNeighbor = new Map<string, (typeof relations)[number]>();
    for (const relation of relations) {
      const neighborId = seedIds.includes(relation.source_id) ? relation.target_id : relation.source_id;
      if (!seen.has(neighborId) && !relationByNeighbor.has(neighborId)) relationByNeighbor.set(neighborId, relation);
    }
    const rows = await this.memories.findActiveByIds([...relationByNeighbor.keys()], repositoryId);
    const related: ScoredMemory[] = [];
    for (const row of rows) {
      const relation = relationByNeighbor.get(row.id);
      if (!relation) continue;
      seen.add(row.id);
      const scored = this.toScoredMemory(row);
      related.push({
        ...scored,
        content: scored.summary,
        relation_source: "memory_relations",
        relation_type: relation.relation_type,
        relation_reason: relation.description ?? `Hard graph edge: ${relation.relation_type}`,
        confidence: relation.confidence,
        content_mode: "summary",
        token_cost_estimate: this.estimateTokens(scored.summary),
      });
    }
    return related.slice(0, 5);
  }

  private async softGraphRelated(
    memories: ScoredMemory[],
    repositoryId: string,
    hardRelated: ScoredMemory[],
  ): Promise<ScoredMemory[]> {
    const seen = new Set([...memories.map((m) => m.id), ...hardRelated.map((m) => m.id)]);
    const candidates = await this.entities.findSoftRelatedMemories(
      memories.slice(0, 5).map((memory) => memory.id),
      repositoryId,
      8,
    );
    const rows = await this.memories.findActiveByIds(
      candidates.map((candidate) => candidate.memory_id).filter((id) => !seen.has(id)),
      repositoryId,
    );
    const rowById = new Map<string, Memory>(rows.map((row) => [row.id, row]));
    const related: ScoredMemory[] = [];
    for (const candidate of candidates) {
      const row = rowById.get(candidate.memory_id);
      if (!row) continue;
      const scored = this.toScoredMemory(row);
      related.push({
        ...scored,
        content: scored.summary,
        relation_source: "shared_entity",
        relation_type: "shared_entity",
        relation_reason: `Shared entities: ${candidate.shared_entities.slice(0, 5).join(", ")}`,
        confidence: Math.min(0.75, 0.35 + candidate.score / 10),
        content_mode: "summary",
        token_cost_estimate: this.estimateTokens(scored.summary),
      });
      if (related.length >= 5) break;
    }
    return related;
  }

  private toScoredMemory(memory: Memory): ScoredMemory {
    return {
      id: memory.id,
      repository_id: memory.repository_id,
      repository_slug: memory.repository_slug ?? null,
      repository_name: memory.repository_name ?? null,
      summary: memory.summary,
      content: memory.content,
      memory_type: memory.memory_type,
      tags: memory.tags,
      importance: memory.importance,
      access_count: memory.access_count,
      last_accessed_at: new Date(memory.last_accessed_at),
      created_at: new Date(memory.created_at),
      valid_from: new Date(memory.valid_from),
      valid_until: memory.valid_until ? new Date(memory.valid_until) : null,
      group_id: memory.group_id,
      sequence: memory.sequence,
      group_type: memory.group_type,
      semantic_score: 0,
      keyword_score: 0,
      composite_score: memory.importance,
    };
  }

  private defaultGraphModeForTopic(topic: string): GraphMode {
    return /[/\\.]|api|endpoint|error|env|package|pkg|file/i.test(topic) ? "auto" : "hard";
  }

  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  private parseMarkdownSections(markdown: string): { title: string; content: string; tags: string[] }[] {
    const sections: { title: string; content: string; tags: string[] }[] = [];
    const parts = markdown.split(/^##\s+/m);
    for (const part of parts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [rawTitle, ...bodyLines] = trimmed.split("\n");
      const parsedTitle = rawTitle?.trim();
      const title = parsedTitle && parsedTitle.length > 0 ? parsedTitle : "Untitled";
      const body = bodyLines.join("\n").trim();
      const tagsMatch = /^\*\*Tags:\*\*\s*(.+)$/im.exec(body);
      const tags =
        tagsMatch?.[1]
          ?.split(",")
          .map((tag) => tag.trim())
          .filter(Boolean) ?? [];
      sections.push({ title, content: body, tags });
    }
    if (sections.length === 0 && markdown.trim()) {
      sections.push({ title: generateSummary(markdown, 80), content: markdown.trim(), tags: [] });
    }
    return sections;
  }

  private inferType(title: string, content: string): MemoryType {
    const text = `${title}\n${content}`.toLowerCase();
    if (text.includes("decision") || text.includes("adr")) return "decision";
    if (text.includes("convention") || text.includes("rule")) return "convention";
    if (text.includes("procedure") || text.includes("runbook") || text.includes("how to")) return "procedure";
    if (content.length > 2000) return "reference";
    return "fact";
  }

  private extractMemoriesFromSummary(summary: string): { content: string; type: MemoryType; tags: string[] }[] {
    const lines = summary
      .split(/\n+/)
      .map((line) => line.trim())
      .filter((line) => line.length > 20);
    if (lines.length === 0) return [{ content: summary, type: "episode", tags: ["session"] }];
    return lines.slice(0, 8).map((line) => ({
      content: line,
      type: /decided|decision|решил|решение/i.test(line) ? "decision" : "episode",
      tags: ["session"],
    }));
  }
}

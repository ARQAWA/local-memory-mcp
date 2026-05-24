import { createHash } from "node:crypto";
import { withTransaction } from "../db/connection.js";
import { ExternalServiceError, ValidationError } from "../errors.js";
import { getRequestContextOrDefault, getSamplingService } from "../context.js";
import type { AuditRepository } from "../repositories/audit.repository.js";
import { AuditRepository as DefaultAuditRepository } from "../repositories/audit.repository.js";
import { EntityRepository, type EntityType } from "../repositories/entity.repository.js";
import { MemoryRepository } from "../repositories/memory.repository.js";
import { RelationRepository } from "../repositories/relation.repository.js";
import type {
  CorrectInput,
  CardType,
  ForgetInput,
  GraphMode,
  GetContextForInput,
  ListMemoriesInput,
  Memory,
  MemoryStats,
  MemorySourceType,
  MemoryStatus,
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
import { LibrarianRunner, type LibrarianUse } from "./librarian.service.js";
import { logger } from "./logger.js";
import type { Reranker, RerankCandidateInput } from "./reranker.service.js";
import { RERANKER_OPERATIONAL_ERROR } from "./reranker.service.js";
import { compositeScore, generateSummary, scoreImportance, tokenBudget } from "./scoring.service.js";

export interface MemoryServiceDeps {
  memories?: MemoryRepository;
  relations?: RelationRepository;
  audit?: AuditRepository;
  entities?: EntityRepository;
  dedup?: DedupService;
  embeddingQueue?: EmbeddingQueue | undefined;
  asyncEmbedding?: boolean | undefined;
  reranker?: Reranker | undefined;
  librarian?: LibrarianRunner | undefined;
}

type PrepareMode = "auto" | "light" | "deep";
type CorrectMemoryAction = "mark_wrong" | "mark_deprecated" | "mark_superseded" | "mark_needs_review" | "mark_current";

interface PrepareContextInput {
  task: string;
  mode?: PrepareMode | undefined;
  repository?: string | undefined;
  working_context?: string | undefined;
  changed_files?: string[] | undefined;
  token_budget?: number | undefined;
  use_librarian?: LibrarianUse | undefined;
}

interface PrepareContextOutput {
  context_pack: string;
  mode_used: "light" | "deep";
  sections: Record<string, string[]>;
  used_memory_ids: string[];
  confidence: number;
  missing_info: string[];
}

interface CommitTaskItem {
  content: string;
  supersedes_id?: string | undefined;
  confidence?: number | undefined;
  anchors?: unknown[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

interface CommitTaskInput {
  task_summary: string;
  decisions?: (string | CommitTaskItem)[] | undefined;
  constraints?: (string | CommitTaskItem)[] | undefined;
  processes?: (string | CommitTaskItem)[] | undefined;
  gotchas?: (string | CommitTaskItem)[] | undefined;
  roadmap?: (string | CommitTaskItem)[] | undefined;
  changed_files?: string[] | undefined;
  open_questions?: string[] | undefined;
  repository?: string | undefined;
}

interface ProjectCandidate {
  memory: Memory;
  fts: number;
  vector: number;
  entity: number;
  type: number;
  importance: number;
  recency: number;
  rerank: number;
  score: number;
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
  private reranker?: Reranker | undefined;
  private librarian: LibrarianRunner;

  constructor(deps?: MemoryServiceDeps) {
    this.memories = deps?.memories ?? new MemoryRepository();
    this.relations = deps?.relations ?? new RelationRepository();
    this.audit = deps?.audit ?? new DefaultAuditRepository();
    this.entities = deps?.entities ?? new EntityRepository();
    this.dedup = deps?.dedup ?? new DedupService(this.memories);
    this.entityExtraction = new EntityExtractionService(this.entities);
    this.embeddingQueue = deps?.embeddingQueue;
    this.asyncEmbedding = deps?.asyncEmbedding ?? false;
    this.reranker = deps?.reranker;
    this.librarian = deps?.librarian ?? new LibrarianRunner();
    if (this.embeddingQueue) {
      this.embeddingQueue.onEmbeddingReady = async (memoryId, embedding) => {
        await this.handlePostEmbeddingDedup(memoryId, embedding);
      };
    }
  }

  async flushSync(): Promise<void> {
    await this.reranker?.close();
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

  async prepareContext(input: PrepareContextInput): Promise<PrepareContextOutput> {
    const selector = input.repository
      ? { repository_mode: "specific" as const, repository: input.repository }
      : { repository_mode: "current" as const };
    const { repository_id } = await this.resolveRepository(selector);
    const baseMode = this.modeForTask(input.task, input.mode ?? "auto");
    const light = await this.retrieveProjectCandidates(input, repository_id, "light");
    let candidates = light.candidates;
    let modeUsed: "light" | "deep" = "light";

    if (baseMode === "deep" || (input.mode ?? "auto") === "auto") {
      const shouldEscalate =
        baseMode === "deep" ||
        this.hasConflictSignal(light.candidates, repository_id) ||
        this.confidenceFor(light.candidates) < 0.45;
      if (shouldEscalate) {
        const deep = await this.retrieveProjectCandidates(input, repository_id, "deep");
        candidates = deep.candidates;
        modeUsed = "deep";
      }
    }

    candidates = await this.rerankProjectCandidates(this.contextQuery(input), candidates);
    candidates = this.selectProjectCandidates(candidates, modeUsed);

    const budget = input.token_budget ?? (modeUsed === "deep" ? 3500 : 900);
    const fallback = this.buildContextPack(candidates, budget, modeUsed);
    const librarian = await this.runLibrarian(input, modeUsed, candidates);
    const result = librarian ?? fallback;
    const usedIds = new Set(result.used_memory_ids);
    if (usedIds.size > 0) {
      this.memories.batchUpdateAccessStats([...usedIds], repository_id).catch((err: unknown) => {
        logger.debug("Failed to update project memory access stats", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
    return result;
  }

  async commitTask(input: CommitTaskInput): Promise<{
    created: number;
    skipped_duplicates: number;
    written_memory_ids: string[];
    open_questions: string[];
  }> {
    const selector = input.repository
      ? { repository_mode: "specific" as const, repository: input.repository }
      : { repository_mode: "current" as const };
    const resolved = await this.resolveRepository(selector);
    if (!resolved.repository || !resolved.repository_id) throw new ValidationError("Repository not found");

    const mappings: { key: keyof CommitTaskInput; memoryType: MemoryType; cardType: CardType; tag: string }[] = [
      { key: "decisions", memoryType: "decision", cardType: "decision", tag: "decision" },
      { key: "processes", memoryType: "procedure", cardType: "process", tag: "process" },
      { key: "constraints", memoryType: "convention", cardType: "constraint", tag: "constraint" },
      { key: "gotchas", memoryType: "episode", cardType: "gotcha", tag: "gotcha" },
      { key: "roadmap", memoryType: "fact", cardType: "roadmap", tag: "roadmap" },
    ];

    let created = 0;
    let skippedDuplicates = 0;
    const written: string[] = [];
    const fileTags = (input.changed_files ?? []).slice(0, 20).map((file) => `file:${file}`);

    for (const mapping of mappings) {
      const values = input[mapping.key];
      if (!Array.isArray(values)) continue;
      for (const raw of values) {
        const item = this.normalizeCommitItem(raw);
        if (!item) continue;
        const externalId = `commit_task:${mapping.cardType}:${this.stableHash(item.content)}`;
        const existing = await this.memories.findByExternalId(resolved.repository_id, externalId);
        if (existing) {
          skippedDuplicates++;
          continue;
        }

        const metadata = {
          task_summary: input.task_summary,
          changed_files: input.changed_files ?? [],
          ...(item.metadata ?? {}),
        };
        const memory = await this.rememberInRepository(
          {
            content: item.content,
            memory_type: mapping.memoryType,
            card_type: mapping.cardType,
            status: "current",
            source_type: "agent",
            confidence: item.confidence ?? 0.85,
            anchors_json: JSON.stringify(item.anchors ?? []),
            metadata_json: JSON.stringify(metadata),
            supersedes_id: item.supersedes_id,
            tags: ["commit-task", mapping.tag, ...fileTags],
            importance: this.defaultImportanceForCard(mapping.cardType),
            external_id: externalId,
            source: "commit_task",
            created_by: getRequestContextOrDefault().user_id,
          },
          resolved.repository,
          item.supersedes_id ?? null,
        );
        if (item.supersedes_id) {
          await this.memories.updateCardState(
            item.supersedes_id,
            { status: "superseded", confidence: 0.7, source_type: "agent", supersedes_id: memory.id },
            resolved.repository_id,
          );
          await this.relations.create({
            repository_id: resolved.repository_id,
            source_id: memory.id,
            target_id: item.supersedes_id,
            relation_type: "supersedes",
            description: "commit_task superseded an older memory card.",
            origin: "lineage",
            confidence: 1,
            metadata: { source: "commit_task" },
            requireActiveEndpoints: false,
          });
        }
        created++;
        written.push(memory.id);
      }
    }

    return {
      created,
      skipped_duplicates: skippedDuplicates,
      written_memory_ids: written,
      open_questions: (input.open_questions ?? []).filter((question) => question.trim().length > 0),
    };
  }

  async correctMemory(input: {
    id: string;
    action: CorrectMemoryAction;
    confidence?: number | undefined;
    source_type?: MemorySourceType | undefined;
    supersedes_id?: string | undefined;
    repository?: string | undefined;
  }): Promise<Memory | null> {
    const selector = input.repository
      ? { repository_mode: "specific" as const, repository: input.repository }
      : { repository_mode: "current" as const };
    const { repository_id } = await this.resolveRepository(selector);
    const memory = await this.memories.findById(input.id, repository_id, { activeOnly: false });
    if (!memory) return null;
    const status = this.statusForAction(input.action);
    const updated = await this.memories.updateCardState(
      input.id,
      {
        status,
        confidence: input.confidence ?? this.confidenceForStatus(status),
        source_type: input.source_type ?? "agent",
        supersedes_id: input.supersedes_id ?? memory.supersedes_id,
      },
      memory.repository_id,
    );
    if (updated) {
      await this.audit.log({
        repository_id: memory.repository_id,
        memory_id: input.id,
        action: "update",
        actor: getRequestContextOrDefault().user_id,
        changes: {
          action: input.action,
          status,
          confidence: input.confidence ?? null,
          source_type: input.source_type ?? "agent",
          supersedes_id: input.supersedes_id ?? null,
        },
      });
    }
    return updated;
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
      .filter(
        (m) =>
          !["deprecated", "superseded", "wrong"].includes(m.status) &&
          ["constraint", "decision", "fact", "process", "architecture", "preference"].includes(m.card_type),
      )
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
      await txMemories.updateCardState(existing.id, { status: "superseded", confidence: 0.7 }, existing.repository_id);
      await txMemories.invalidate(existing.id, existing.repository_id);
      const created = await txMemories.create({
        repository_id: existing.repository_id,
        user_id: existing.user_id,
        memory_type: existing.memory_type,
        card_type: existing.card_type,
        status: "current",
        source_type: "agent",
        confidence: 0.9,
        content: input.new_content,
        summary: generateSummary(input.new_content),
        importance: existing.importance,
        created_by: input.actor,
        source: existing.source,
        supersedes: existing.id,
        supersedes_id: existing.id,
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
    return this.memories.purgeByUser(userId, repository_id);
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
    const existing = this.memories.listBlocks(repository.id).find((block) => block.name === name);
    const next =
      operation === "append" && existing
        ? `${existing.content}\n${content}`
        : operation === "prepend" && existing
          ? `${content}\n${existing.content}`
          : content;
    return this.memories.upsertBlock(repository.id, name, next, maxTokens);
  }

  async listMemoryBlocks(): Promise<{ name: string; content: string; max_tokens: number; repository_id: string }[]> {
    const repository = await this.currentRepository();
    return this.memories.listBlocks(repository.id);
  }

  async deleteMemoryBlock(name: string): Promise<boolean> {
    const repository = await this.currentRepository();
    return this.memories.deleteBlock(repository.id, name);
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
          {
            content: input.content,
            summary,
            importance,
            memory_type: input.memory_type,
            card_type: input.card_type,
            status: input.status,
            source_type: input.source_type,
            confidence: input.confidence,
            anchors_json: input.anchors_json,
            metadata_json: input.metadata_json,
            supersedes_id: input.supersedes_id,
            embedding,
          },
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
            card_type: input.card_type,
            status: input.status,
            source_type: input.source_type,
            confidence: input.confidence,
            anchors_json: input.anchors_json,
            metadata_json: input.metadata_json,
            supersedes_id: input.supersedes_id,
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
      card_type: input.card_type,
      status: input.status,
      source_type: input.source_type,
      confidence: input.confidence,
      anchors_json: input.anchors_json,
      metadata_json: input.metadata_json,
      content: input.content,
      summary,
      importance,
      created_by: input.created_by,
      source: input.source ?? null,
      supersedes: supersedes ?? existingToSupersede ?? null,
      supersedes_id: input.supersedes_id ?? supersedes ?? existingToSupersede ?? null,
      external_id: input.external_id ?? null,
      embedding,
      expires_at: expiresAt,
      group_id: input.group_id ?? null,
      sequence: input.sequence ?? null,
      group_type: input.group_type ?? null,
    });
    await this.memories.setTags(memory.id, tags, repository.id);
    if (existingToSupersede) {
      await this.memories.updateCardState(
        existingToSupersede,
        { status: "superseded", confidence: 0.7, source_type: "agent", supersedes_id: memory.id },
        repository.id,
      );
      await this.memories.invalidate(existingToSupersede, repository.id);
    }
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

  private async retrieveProjectCandidates(
    input: PrepareContextInput,
    repositoryId: string | undefined,
    mode: "light" | "deep",
  ): Promise<{ candidates: ProjectCandidate[] }> {
    const query = this.contextQuery(input);
    const filters = { repository_id: repositoryId };
    const embedding = await this.generateEmbedding(query, "query");
    const searchLimit = mode === "deep" ? 80 : 30;
    const fts = await this.memories.searchFts(query, filters, searchLimit);
    const semantic = embedding ? await this.memories.searchSemantic(embedding, filters, searchLimit) : [];
    const entity = await this.memories.searchByTagsEntitiesAndText(query, filters, searchLimit);
    const candidateMap = new Map<string, ProjectCandidate>();

    this.mergeCandidates(candidateMap, fts, "fts");
    this.mergeCandidates(candidateMap, semantic, "vector");
    this.mergeCandidates(candidateMap, entity, "entity");

    if (mode === "deep") {
      const typePrior = await this.memories.listByCardTypes(this.typePriorsForTask(input.task), filters, 50);
      this.mergeCandidates(candidateMap, typePrior, "type");
      const seedIds = [...candidateMap.values()]
        .sort((a, b) => Math.max(b.fts, b.vector, b.entity, b.type) - Math.max(a.fts, a.vector, a.entity, a.type))
        .slice(0, 20)
        .map((candidate) => String(candidate.memory.id));
      const relations = await this.relations.findByEntries(seedIds, repositoryId, { activeOnly: false });
      const neighborIds = relations
        .map((relation) => (seedIds.includes(relation.source_id) ? relation.target_id : relation.source_id))
        .filter((id, index, ids) => !seedIds.includes(id) && ids.indexOf(id) === index);
      const neighbors = await this.memories.findActiveByIds(neighborIds, repositoryId);
      const relationScore = new Map<string, number>();
      for (const relation of relations) {
        const id = seedIds.includes(relation.source_id) ? relation.target_id : relation.source_id;
        relationScore.set(id, Math.max(relationScore.get(id) ?? 0, relation.confidence));
      }
      for (const memory of neighbors) {
        this.mergeMemoryCandidate(candidateMap, memory, "entity", relationScore.get(memory.id) ?? 0.5);
      }
    }

    return { candidates: this.scoreProjectCandidates([...candidateMap.values()], mode) };
  }

  private mergeCandidates(
    target: Map<string, ProjectCandidate>,
    memories: (Memory & { score?: number })[],
    source: "fts" | "vector" | "entity" | "type",
  ): void {
    for (const memory of memories) {
      this.mergeMemoryCandidate(target, memory, source, memory.score ?? 1);
    }
  }

  private mergeMemoryCandidate(
    target: Map<string, ProjectCandidate>,
    memory: Memory,
    source: "fts" | "vector" | "entity" | "type",
    score: number,
  ): void {
    if (memory.status === "wrong") return;
    const current =
      target.get(memory.id) ??
      ({
        memory,
        fts: 0,
        vector: 0,
        entity: 0,
        type: 0,
        importance: memory.importance,
        recency: this.recencyScore(memory.updated_at),
        rerank: 0,
        score: 0,
      } satisfies ProjectCandidate);
    current[source] = Math.max(current[source], score);
    target.set(memory.id, current);
  }

  private scoreProjectCandidates(candidates: ProjectCandidate[], mode: "light" | "deep"): ProjectCandidate[] {
    const maxFts = Math.max(0.0001, ...candidates.map((candidate) => candidate.fts));
    const maxVector = Math.max(0.0001, ...candidates.map((candidate) => candidate.vector));
    const maxEntity = Math.max(0.0001, ...candidates.map((candidate) => candidate.entity));
    const maxType = Math.max(0.0001, ...candidates.map((candidate) => candidate.type));
    const scored = candidates
      .filter((candidate) => candidate.memory.status !== "wrong")
      .map((candidate) => {
        const base =
          (candidate.fts / maxFts) * 0.35 +
          (candidate.vector / maxVector) * 0.35 +
          (candidate.entity / maxEntity) * 0.1 +
          (candidate.type / maxType) * 0.1 +
          candidate.memory.importance * 0.05 +
          candidate.recency * 0.05;
        return { ...candidate, score: Math.max(0, base + this.statusModifier(candidate.memory.status)) };
      })
      .sort((a, b) => b.score - a.score);
    return scored.slice(0, mode === "deep" ? 150 : 30);
  }

  private buildContextPack(
    candidates: ProjectCandidate[],
    tokenBudgetValue: number,
    mode: "light" | "deep",
  ): PrepareContextOutput {
    const sections: Record<string, string[]> = {
      "Hard rules": [],
      "Current decisions": [],
      Process: [],
      Architecture: [],
      Legacy: [],
      Gotchas: [],
      Roadmap: [],
      "Codebase hints": [],
      "Open questions": [],
      Confidence: [],
    };
    const used = new Set<string>();
    let usedTokens = 0;
    const budget = Math.max(100, tokenBudgetValue);

    for (const candidate of candidates) {
      const section = this.sectionForMemory(candidate.memory);
      const line = this.formatContextLine(candidate);
      const cost = this.estimateTokens(line);
      if (usedTokens + cost > budget && used.size > 0) continue;
      sections[section]?.push(line);
      used.add(candidate.memory.id);
      usedTokens += cost;
      if (candidate.memory.status === "needs_review" || candidate.memory.status === "candidate") {
        sections["Open questions"]?.push(`${candidate.memory.summary} (${candidate.memory.status})`);
      }
    }

    const confidence = this.confidenceFor(candidates);
    const missingInfo = used.size === 0 ? ["No relevant project memory found."] : [];
    if (confidence < 0.5) missingInfo.push("Project memory confidence is low.");
    sections["Confidence"] = [`${Math.round(confidence * 100)}% from ${used.size} memory cards (${mode}).`];
    const contextPack = Object.entries(sections)
      .filter(([, lines]) => lines.length > 0)
      .map(([name, lines]) => [`## ${name}`, ...lines.map((line) => `- ${line}`)].join("\n"))
      .join("\n\n");
    return {
      context_pack: contextPack,
      mode_used: mode,
      sections,
      used_memory_ids: [...used],
      confidence,
      missing_info: missingInfo,
    };
  }

  private async rerankProjectCandidates(query: string, candidates: ProjectCandidate[]): Promise<ProjectCandidate[]> {
    if (!this.reranker) {
      throw new ExternalServiceError("Jina MLX reranker", `${RERANKER_OPERATIONAL_ERROR}: backend started without worker`);
    }
    if (candidates.length === 0) return [];
    const rerankInput: RerankCandidateInput[] = candidates.map((candidate) => ({
      id: candidate.memory.id,
      text: this.rerankText(candidate.memory),
    }));
    const results = await this.reranker.rerank(query, rerankInput);
    const byId = new Map(candidates.map((candidate) => [String(candidate.memory.id), candidate]));
    const ordered: ProjectCandidate[] = [];
    for (const result of results) {
      const candidate = byId.get(result.id);
      if (!candidate) continue;
      ordered.push({ ...candidate, rerank: result.score, score: this.scoreWithRerank(candidate, result.score) });
    }
    const seen = new Set(ordered.map((candidate) => candidate.memory.id));
    const rest = candidates
      .filter((candidate) => !seen.has(candidate.memory.id))
      .map((candidate) => ({ ...candidate, score: this.scoreWithRerank(candidate, candidate.rerank) }));
    return this.sortByStatusAndScore([...ordered, ...rest]);
  }

  private async runLibrarian(
    input: PrepareContextInput,
    mode: "light" | "deep",
    candidates: ProjectCandidate[],
  ): Promise<PrepareContextOutput | null> {
    const output = await this.librarian.run({
      task: input.task,
      mode,
      use: input.use_librarian,
      candidates: this.commandCandidates(candidates),
    });
    if (!output) return null;
    const { sections, used_memory_ids: usedIds, confidence, missing_info: missingInfo } = output;
    return {
      context_pack: Object.entries(sections)
        .filter(([, lines]) => lines.length > 0)
        .map(([name, lines]) => [`## ${name}`, ...lines.map((line) => `- ${line}`)].join("\n"))
        .join("\n\n"),
      mode_used: mode,
      sections,
      used_memory_ids: usedIds,
      confidence,
      missing_info: missingInfo,
    };
  }

  private contextQuery(input: PrepareContextInput): string {
    return [input.task, input.working_context, ...(input.changed_files ?? [])].filter(Boolean).join("\n");
  }

  private modeForTask(task: string, requested: PrepareMode): "light" | "deep" {
    if (requested === "light" || requested === "deep") return requested;
    if (
      /(auth|security|billing|migration|architecture|debug|refactor|безопас|миграц|архитект|рефактор|отлад)/i.test(task)
    ) {
      return "deep";
    }
    return "light";
  }

  private typePriorsForTask(task: string): CardType[] {
    const base: CardType[] = ["constraint", "decision", "process", "architecture", "legacy", "gotcha"];
    if (/roadmap|plan|план|road/i.test(task)) base.push("roadmap");
    if (/preference|user|предпоч/i.test(task)) base.push("preference");
    return base;
  }

  private selectProjectCandidates(candidates: ProjectCandidate[], mode: "light" | "deep"): ProjectCandidate[] {
    const sorted = this.sortByStatusAndScore(candidates);
    if (mode === "light") return this.dedupProjectCandidates(sorted).slice(0, 10);
    return this.mmrDedupCandidates(sorted, 80);
  }

  private scoreWithRerank(candidate: ProjectCandidate, rerankScore: number): number {
    const normalizedRerank = Number.isFinite(rerankScore) ? Math.max(0, Math.min(1, (rerankScore + 1) / 2)) : 0;
    return candidate.score * 0.35 + normalizedRerank * 0.65;
  }

  private sortByStatusAndScore(candidates: ProjectCandidate[]): ProjectCandidate[] {
    return [...candidates].sort((a, b) => {
      const statusDiff = this.statusRank(a.memory.status) - this.statusRank(b.memory.status);
      if (statusDiff !== 0) return statusDiff;
      return b.score - a.score;
    });
  }

  private statusRank(status: MemoryStatus): number {
    if (status === "current") return 0;
    if (status === "candidate" || status === "needs_review") return 1;
    if (status === "temporary") return 2;
    return 3;
  }

  private sectionForMemory(memory: Memory): string {
    if (
      memory.status === "deprecated" ||
      memory.status === "superseded" ||
      memory.status === "historical" ||
      memory.status === "temporary" ||
      memory.card_type === "legacy"
    )
      return "Legacy";
    if (memory.card_type === "constraint") return "Hard rules";
    if (memory.card_type === "decision") return "Current decisions";
    if (memory.card_type === "process") return "Process";
    if (memory.card_type === "architecture") return "Architecture";
    if (memory.card_type === "gotcha") return "Gotchas";
    if (memory.card_type === "roadmap") return "Roadmap";
    return "Codebase hints";
  }

  private formatContextLine(candidate: ProjectCandidate): string {
    const memory = candidate.memory;
    const score = Math.round(candidate.score * 100) / 100;
    return `[${memory.id}] ${memory.summary} (${memory.card_type}, ${memory.status}, score ${score})`;
  }

  private statusModifier(status: MemoryStatus): number {
    if (status === "current") return 0.2;
    if (status === "candidate") return -0.15;
    if (status === "needs_review") return -0.2;
    if (status === "deprecated") return -0.5;
    if (status === "superseded") return -0.6;
    return 0;
  }

  private confidenceFor(candidates: ProjectCandidate[]): number {
    if (candidates.length === 0) return 0;
    const top = Math.max(...candidates.map((candidate) => candidate.score));
    const countBoost = Math.min(0.25, candidates.length / 40);
    return Math.max(0, Math.min(1, top * 0.75 + countBoost));
  }

  private hasConflictSignal(candidates: ProjectCandidate[], _repositoryId: string | undefined): boolean {
    return candidates.some((candidate) => /conflict|contradict|конфликт|противореч/i.test(candidate.memory.content));
  }

  private dedupProjectCandidates(candidates: ProjectCandidate[]): ProjectCandidate[] {
    const seen = new Set<string>();
    const result: ProjectCandidate[] = [];
    for (const candidate of candidates) {
      const key = `${candidate.memory.card_type}:${candidate.memory.summary.toLowerCase().replace(/\s+/g, " ").trim()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
    return result;
  }

  private mmrDedupCandidates(candidates: ProjectCandidate[], limit: number): ProjectCandidate[] {
    const pool = this.dedupProjectCandidates(candidates);
    const selected: ProjectCandidate[] = [];
    const selectedTerms: Set<string>[] = [];
    while (pool.length > 0 && selected.length < limit) {
      let bestIndex = 0;
      let bestScore = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < pool.length; i += 1) {
        const candidate = pool[i];
        if (!candidate) continue;
        const terms = this.textTerms(`${candidate.memory.summary}\n${candidate.memory.content}`);
        const diversityPenalty = selectedTerms.length
          ? Math.max(...selectedTerms.map((other) => this.jaccard(terms, other)))
          : 0;
        const mmrScore = candidate.score * 0.85 - diversityPenalty * 0.15 - this.statusRank(candidate.memory.status) * 0.01;
        if (mmrScore > bestScore) {
          bestScore = mmrScore;
          bestIndex = i;
        }
      }
      const [next] = pool.splice(bestIndex, 1);
      if (!next) break;
      selected.push(next);
      selectedTerms.push(this.textTerms(`${next.memory.summary}\n${next.memory.content}`));
    }
    return selected;
  }

  private textTerms(text: string): Set<string> {
    return new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}_./:-]+/u)
        .filter((term) => term.length >= 3)
        .slice(0, 80),
    );
  }

  private jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 || b.size === 0) return 0;
    let overlap = 0;
    for (const term of a) {
      if (b.has(term)) overlap += 1;
    }
    return overlap / (a.size + b.size - overlap);
  }

  private recencyScore(value: Date): number {
    const ageMs = Date.now() - value.getTime();
    if (Number.isNaN(ageMs)) return 0;
    const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
    return Math.min(1, Math.exp((-Math.LN2 * ageDays) / 45));
  }

  private rerankText(memory: Memory): string {
    return `${memory.summary}\n\n${memory.content}`.slice(0, 3_000);
  }

  private commandCandidates(candidates: ProjectCandidate[]): RerankCandidateInput[] {
    return candidates.slice(0, 40).map((candidate) => ({
      id: candidate.memory.id,
      text: JSON.stringify({
        summary: candidate.memory.summary,
        content: candidate.memory.content.slice(0, 2_000),
        card_type: candidate.memory.card_type,
        status: candidate.memory.status,
        tags: candidate.memory.tags,
        score: candidate.score,
      }),
    }));
  }

  private normalizeCommitItem(item: string | CommitTaskItem): CommitTaskItem | null {
    if (typeof item === "string") {
      const content = item.trim();
      return content ? { content } : null;
    }
    const content = item.content.trim();
    return content ? { ...item, content } : null;
  }

  private stableHash(content: string): string {
    return createHash("sha256").update(content.trim().replace(/\s+/g, " ").toLowerCase()).digest("hex").slice(0, 32);
  }

  private defaultImportanceForCard(cardType: CardType): number {
    if (cardType === "constraint" || cardType === "decision") return 0.8;
    if (cardType === "process" || cardType === "architecture") return 0.7;
    if (cardType === "gotcha") return 0.65;
    return 0.55;
  }

  private statusForAction(action: CorrectMemoryAction): MemoryStatus {
    if (action === "mark_wrong") return "wrong";
    if (action === "mark_deprecated") return "deprecated";
    if (action === "mark_superseded") return "superseded";
    if (action === "mark_needs_review") return "needs_review";
    return "current";
  }

  private confidenceForStatus(status: MemoryStatus): number {
    if (status === "wrong") return 0;
    if (status === "deprecated" || status === "superseded") return 0.5;
    if (status === "needs_review") return 0.4;
    return 0.85;
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
      card_type: memory.card_type,
      status: memory.status,
      source_type: memory.source_type,
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

import { MemoryRepository, TeamRepository, parseJsonTags } from "../repositories/memory.repository.js";
import { RelationRepository } from "../repositories/relation.repository.js";
import { AuditRepository } from "../repositories/audit.repository.js";
import { EntityRepository } from "../repositories/entity.repository.js";
import type { EntityType } from "../repositories/entity.repository.js";
import { getEmbeddingProvider, type EmbeddingPurpose } from "./embedding.service.js";
import { withTransaction } from "../db/connection.js";
import { DedupService } from "./dedup.service.js";
import { EntityExtractionService } from "./entity-extraction.service.js";
import { MemoryPolicyService } from "./memory-policy.service.js";
import type { PolicyRules, MemoryPolicy } from "./memory-policy.service.js";
import { scoreImportance, compositeScore, tokenBudget, generateSummary } from "./scoring.service.js";
import { toMemoryId, toOrgId, toUserId, toTeamSlug } from "../types/index.js";
import type {
  Memory,
  MemoryType,
  RelationType,
  RememberInput,
  RememberFactInput,
  RememberDecisionInput,
  RecallInput,
  GetContextForInput,
  ForgetInput,
  CorrectInput,
  ListMemoriesInput,
  SearchMemoriesInput,
  RecallResult,
  MemoryStats,
} from "../types/memory.js";
import type { TokenBudgetResult, ScoredMemory } from "../types/scoring.js";
import { logger } from "./logger.js";
import { NotFoundError } from "../errors.js";
import { getSamplingService, requestContext } from "../context.js";
import { getDb } from "../db/connection.js";
import type { EmbeddingQueue } from "./embedding-queue.js";

interface SyncResult {
  pushed: number;
  errors: unknown[];
}

/** Optional local extension point. No sync provider is wired in local-only mode. */
export interface SyncProvider {
  queuePush(memoryId: string): void;
  flushPending(): Promise<SyncResult>;
}

export interface MemoryServiceDeps {
  memories?: MemoryRepository | undefined;
  teams?: TeamRepository | undefined;
  relations?: RelationRepository | undefined;
  audit?: AuditRepository | undefined;
  entities?: EntityRepository | undefined;
  sync?: SyncProvider | undefined;
  embeddingQueue?: EmbeddingQueue | undefined;
  asyncEmbedding?: boolean | undefined;
}

export class MemoryService {
  private memories: MemoryRepository;
  private teams: TeamRepository;
  private relations: RelationRepository;
  private audit: AuditRepository;
  private entityRepo: EntityRepository;
  private dedup: DedupService;
  private entityExtraction: EntityExtractionService;
  private policyService: MemoryPolicyService;
  private sync?: SyncProvider | undefined;
  private embeddingQueue?: EmbeddingQueue | undefined;
  private asyncEmbedding: boolean;

  constructor(deps?: MemoryServiceDeps) {
    this.memories = deps?.memories ?? new MemoryRepository();
    this.teams = deps?.teams ?? new TeamRepository();
    this.relations = deps?.relations ?? new RelationRepository();
    this.audit = deps?.audit ?? new AuditRepository();
    this.entityRepo = deps?.entities ?? new EntityRepository();
    this.dedup = new DedupService(this.memories);
    this.entityExtraction = new EntityExtractionService(this.entityRepo);
    this.policyService = new MemoryPolicyService();
    this.sync = deps?.sync;
    this.embeddingQueue = deps?.embeddingQueue;
    this.asyncEmbedding = deps?.asyncEmbedding ?? false;

    // Track memory IDs that have been re-enqueued after merge to prevent infinite loops.
    // Entries are cleared after 5 minutes to allow legitimate future re-embeddings.
    const reembedCycleGuard = new Set<string>();
    const reembedTimers = new Map<string, ReturnType<typeof setTimeout>>();
    const CYCLE_GUARD_TTL_MS = 5 * 60 * 1000;

    // Wire post-embedding dedup so async-created memories get checked for duplicates
    if (this.embeddingQueue) {
      this.embeddingQueue.onEmbeddingReady = async (memoryId: string, embedding: number[]) => {
        try {
          const memory = await this.memories.findById(memoryId);
          if (!memory) return;
          // Run within the memory owner's request context so audit logs
          // and any downstream service calls get correct org/user context.
          await requestContext.run(
            {
              org_id: memory.org_id,
              user_id: memory.created_by,
              role: "writer",
            },
            () =>
              this.handlePostEmbeddingDedup(
                memory,
                memoryId,
                embedding,
                reembedCycleGuard,
                reembedTimers,
                CYCLE_GUARD_TTL_MS,
              ),
          );
        } catch (err: unknown) {
          logger.warn("Post-embedding dedup check failed", {
            memory_id: memoryId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      };
    }
  }

  /** Post-embedding dedup handler — extracted to run within request context. */
  private async handlePostEmbeddingDedup(
    memory: Memory,
    memoryId: string,
    embedding: number[],
    reembedCycleGuard: Set<string>,
    reembedTimers: Map<string, ReturnType<typeof setTimeout>>,
    CYCLE_GUARD_TTL_MS: number,
  ): Promise<void> {
    const result = await this.dedup.findDuplicates(
      embedding,
      memory.content,
      undefined,
      { org_id: memory.org_id, team_id: memory.team_id },
      memoryId,
    );

    if (result.action === "merge" && result.existing_id) {
      // Merge content into existing memory instead of just deleting
      const existing = await this.memories.findById(result.existing_id, memory.org_id);
      if (!existing) return;
      const mergedContent = this.dedup.mergeContent(existing.content, memory.content);
      const mergedSummary = generateSummary(mergedContent);
      const memTags = await this.memories.getTagsForMemory(memory.id);

      // Wrap merge operations in a transaction for atomicity
      await withTransaction(async (txSql) => {
        const txProvider = () => txSql;
        const txMemories = this.memories.withSql(txProvider);
        // Optimistic locking: re-read existing inside transaction to detect concurrent changes
        const fresh = await txMemories.findById(existing.id, memory.org_id);
        if (!fresh || fresh.updated_at > existing.updated_at) return;
        await txMemories.update(
          existing.id,
          {
            content: mergedContent,
            summary: mergedSummary,
            importance: Math.max(existing.importance, memory.importance),
          },
          memory.org_id,
        );
        // Merge tags
        const existingTags = new Set(existing.tags);
        const newTags = memTags.filter((t) => !existingTags.has(t));
        if (newTags.length > 0) {
          await txMemories.setTags(existing.id, [...existing.tags, ...newTags]);
        }
        await txMemories.softDelete(memoryId, memory.org_id);
      });

      // Re-enqueue merged content for fresh embedding (with cycle guard)
      if (this.embeddingQueue && !reembedCycleGuard.has(existing.id)) {
        reembedCycleGuard.add(existing.id);
        const timer = setTimeout(() => {
          reembedCycleGuard.delete(existing.id);
          reembedTimers.delete(existing.id);
        }, CYCLE_GUARD_TTL_MS);
        timer.unref();
        reembedTimers.set(existing.id, timer);
        this.embeddingQueue.enqueue(existing.id, `${mergedSummary}\n${mergedContent}`, "document", memory.org_id);
      }
      this.queueSync(existing.id);
      this.queueSync(memoryId);
      logger.info("Post-embedding dedup: merged into existing", {
        memory_id: memoryId,
        existing_id: result.existing_id,
      });
    } else if (result.action === "supersede" && result.existing_id) {
      // New memory supersedes the old one — wrap in transaction for atomicity
      const existingId = result.existing_id;
      await withTransaction(async (txSql) => {
        const txProvider = () => txSql;
        const txMemories = this.memories.withSql(txProvider);
        const txRelations = this.relations.withSql(txProvider);
        await txMemories.update(
          memoryId,
          {
            supersedes: existingId,
          },
          memory.org_id,
        );
        await txMemories.invalidate(existingId, memory.org_id);
        await txRelations
          .create(
            {
              source_id: memoryId,
              target_id: existingId,
              relation_type: "supersedes",
            },
            memory.org_id,
          )
          .catch(() => {}); // ignore if relation already exists
      });
      this.queueSync(memoryId);
      this.queueSync(existingId);
      logger.info("Post-embedding dedup: superseded existing", {
        memory_id: memoryId,
        existing_id: result.existing_id,
      });
    }
  }

  /** Queue hook. No-op in local-only mode because no sync provider is configured. */
  private queueSync(memoryId: string): void {
    if (this.sync) {
      this.sync.queuePush(memoryId);
    }
  }

  /** Flush optional queue on shutdown. No-op in local-only mode. */
  async flushSync(): Promise<void> {
    if (this.sync) {
      const result = await this.sync.flushPending();
      if (result.pushed > 0 || result.errors.length > 0) {
        logger.info("Sync flush", {
          pushed: result.pushed,
          errors: result.errors.length,
        });
      }
    }
  }

  // ─── Write Tools ───

  /**
   * Primary write tool. Records a memory with smart pipeline:
   * 1. Evaluate memory policy (selective memory)
   * 2. Generate summary if not provided
   * 3. Score importance
   * 4. Generate embedding
   * 5. Check for duplicates
   * 6. Create, merge, or supersede
   * 7. Extract entities and build knowledge graph
   */
  async remember(input: RememberInput): Promise<Memory & { dedup_action: string }> {
    const teamId = input.team_slug
      ? (await this.teams.findOrCreate(input.team_slug, undefined, input.org_id)).id
      : null;

    // Step 0: Evaluate memory policy (selective memory rules)
    const policyResult = await this.policyService.evaluate(input.content, input.org_id, teamId);
    if (!policyResult.allowed) {
      logger.info("Memory filtered by policy", {
        reason: policyResult.reason,
      });
      // Return a synthetic "filtered" result without persisting
      return {
        id: toMemoryId("00000000-0000-0000-0000-000000000000"),
        content: input.content,
        summary: policyResult.reason ?? "Filtered by memory policy",
        embedding: null,
        memory_type: input.memory_type,
        scope: input.scope,
        tags: input.tags,
        org_id: toOrgId(input.org_id),
        team_id: teamId ? toTeamSlug(teamId) : null,
        user_id: input.user_id ? toUserId(input.user_id) : null,
        valid_from: new Date(),
        valid_until: null,
        expires_at: null,
        created_at: new Date(),
        updated_at: new Date(),
        importance: 0,
        access_count: 0,
        last_accessed_at: new Date(),
        created_by: toUserId(input.created_by),
        source: input.source ?? null,
        external_id: input.external_id ?? null,
        supersedes: null,
        group_id: input.group_id ?? null,
        sequence: input.sequence ?? null,
        group_type: input.group_type ?? null,
        local_only: input.local_only,
        title: "",
        author: input.created_by,
        status: "filtered",
        type: input.memory_type,
        visibility: input.scope,
        metadata: null,
        dedup_action: "filtered",
      };
    }

    // Add policy-suggested tags
    if (policyResult.suggestedTags && policyResult.suggestedTags.length > 0) {
      input = {
        ...input,
        tags: [...new Set([...input.tags, ...policyResult.suggestedTags])],
      };
    }

    // External ID upsert: if external_id is provided, check for existing memory first
    if (input.external_id) {
      const existing = await this.memories.findByExternalId(input.org_id, input.external_id);
      if (existing) {
        return this.upsertByExternalId(existing, input, teamId);
      }
    }

    // 1+2. Generate summary and score importance in parallel (independent operations)
    const sampling = getSamplingService();
    const importancePromise =
      input.importance != null
        ? Promise.resolve(input.importance)
        : sampling
          ? sampling.scoreImportance(input.content, input.memory_type, input.scope)
          : Promise.resolve(scoreImportance(input.content, input.memory_type, input.scope));

    const [summary, importance] = await Promise.all([
      sampling ? sampling.summarize(input.content) : Promise.resolve(generateSummary(input.content)),
      importancePromise,
    ]);

    // 3. Generate embedding with contextual prefix for better retrieval
    const prefix = this.buildEmbeddingPrefix({
      memory_type: input.memory_type,
      scope: input.scope,
      team_slug: input.team_slug,
      tags: input.tags,
      source: input.source,
    });
    const embeddingText = `${prefix} ${summary}\n${input.content}`;

    // In async mode, skip embedding + dedup for faster writes (FTS still works)
    const embedding = this.asyncEmbedding ? null : await this.generateEmbedding(embeddingText);

    // 4. Dedup check (scoped to org/team to avoid cross-tenant matches)
    // Skipped in async mode (no embedding available for similarity check)
    const dedupResult = embedding
      ? await this.dedup.findDuplicates(embedding, input.content, undefined, {
          org_id: input.org_id,
          team_id: teamId,
        })
      : { action: "create" as const, similarity: 0, existing_id: undefined };

    if (dedupResult.action === "merge" && dedupResult.existing_id) {
      // Merge with existing memory — re-read inside transaction for optimistic locking
      const existing = await this.memories.findById(dedupResult.existing_id, input.org_id);
      if (existing) {
        // Prepare merge content outside transaction to avoid holding locks during LLM/embedding calls
        const mergedContent = this.dedup.mergeContent(existing.content, input.content);
        const samplingForMerge = getSamplingService();
        const mergedSummary = samplingForMerge
          ? await samplingForMerge.summarize(mergedContent)
          : generateSummary(mergedContent);
        const mergePrefix = this.buildEmbeddingPrefix({
          memory_type: existing.memory_type,
          scope: existing.scope,
          team_slug: input.team_slug,
          tags: [...existing.tags, ...input.tags],
          source: input.source,
        });
        const mergedEmbeddingText = `${mergePrefix} ${mergedSummary}\n${mergedContent}`;
        const mergedEmbedding = this.asyncEmbedding ? null : await this.generateEmbedding(mergedEmbeddingText);
        const existingUpdatedAt = new Date(existing.updated_at);

        // Wrap merge writes in a transaction with optimistic locking
        const mergeResult = await withTransaction(async (txSql) => {
          const txProvider = () => txSql;
          const txMemories = this.memories.withSql(txProvider);
          const txAudit = this.audit.withSql(txProvider);

          // Re-read to check for concurrent modification (optimistic lock)
          const fresh = await txMemories.findById(existing.id, input.org_id);
          if (!fresh || new Date(fresh.updated_at).getTime() !== existingUpdatedAt.getTime()) {
            // Concurrently modified or deleted — fall through to create
            return null;
          }

          const updated = await txMemories.update(existing.id, {
            content: mergedContent,
            summary: mergedSummary,
            embedding: mergedEmbedding,
            importance: Math.max(existing.importance, importance),
          });

          if (!updated) return null;

          const existingTags = new Set(existing.tags);
          const mergedTags = [...existingTags, ...input.tags.filter((t) => !existingTags.has(t))];
          await txMemories.setTags(updated.id, mergedTags);

          await txAudit.log({
            entry_id: updated.id,
            action: "update",
            actor: input.created_by,
            changes: {
              dedup_action: "merge",
              similarity: dedupResult.similarity,
            },
          });

          return { ...updated, tags: mergedTags };
        });

        if (mergeResult) {
          this.queueSync(mergeResult.id);
          // Enqueue merged content for background embedding in async mode
          if (this.asyncEmbedding && !mergedEmbedding && this.embeddingQueue) {
            this.embeddingQueue.enqueue(mergeResult.id, mergedEmbeddingText, "document", input.org_id);
          }
          return { ...mergeResult, dedup_action: "merged" };
        }
        // If update returned null (concurrent modification or delete), fall through to create
      }
    }

    // Auto-extract entity tags BEFORE transaction to avoid holding locks during LLM calls
    const samplingForTags = getSamplingService();
    const llmTags = samplingForTags ? await samplingForTags.extractEntities(input.content) : null;
    const autoTags = llmTags ?? this.extractEntities(input.content);
    const allTags = [...new Set([...input.tags, ...autoTags])];

    // Wrap create + tags + supersede + audit in a transaction
    const result = await withTransaction(async (txSql) => {
      const txProvider = () => txSql;
      const txMemories = this.memories.withSql(txProvider);
      const txRelations = this.relations.withSql(txProvider);
      const txAudit = this.audit.withSql(txProvider);

      // Compute expiration date from TTL if provided
      const expiresAt = input.ttl_days ? new Date(Date.now() + input.ttl_days * 24 * 60 * 60 * 1000) : null;

      // Create new memory
      const created = await txMemories.create({
        team_id: teamId,
        org_id: input.org_id,
        user_id: input.user_id ?? null,
        memory_type: input.memory_type,
        scope: input.scope,
        content: input.content,
        summary,
        importance,
        created_by: input.created_by,
        source: input.source ?? null,
        supersedes: dedupResult.action === "supersede" ? (dedupResult.existing_id ?? null) : null,
        external_id: input.external_id ?? null,
        embedding,
        expires_at: expiresAt,
        group_id: input.group_id ?? null,
        sequence: input.sequence ?? null,
        group_type: input.group_type ?? null,
        local_only: input.local_only,
      });

      if (allTags.length > 0) {
        await txMemories.setTags(created.id, allTags);
        created.tags = allTags;
      }

      // Supersede: now that new memory exists safely, invalidate the old one
      if (dedupResult.action === "supersede" && dedupResult.existing_id) {
        await txMemories.invalidate(dedupResult.existing_id, input.org_id);
        await txRelations.create(
          {
            source_id: created.id,
            target_id: dedupResult.existing_id,
            relation_type: "supersedes",
            description: `Auto-superseded (similarity: ${dedupResult.similarity?.toFixed(3)})`,
          },
          input.org_id,
        );
        await txAudit.log({
          entry_id: dedupResult.existing_id,
          action: "update",
          actor: input.created_by,
          changes: {
            dedup_action: "superseded",
            superseded_by: created.id,
          },
        });
      }

      await txAudit.log({
        entry_id: created.id,
        action: "create",
        actor: input.created_by,
        changes: {
          memory_type: input.memory_type,
          scope: input.scope,
          dedup_action: dedupResult.action,
        },
      });

      return created;
    });

    const memory = result;
    if (!memory.local_only) {
      this.queueSync(memory.id);
    }

    // Also queue the invalidated old memory so its valid_until propagates via sync
    // But only if the superseded memory is not local_only (avoid leaking local-only data)
    if (dedupResult.action === "supersede" && dedupResult.existing_id) {
      const existingMemory = await this.memories.findById(dedupResult.existing_id, input.org_id);
      if (existingMemory && !existingMemory.local_only) {
        this.queueSync(dedupResult.existing_id);
      }
    }

    // Async embedding: enqueue for background processing
    if (this.asyncEmbedding && !embedding && this.embeddingQueue) {
      this.embeddingQueue.enqueue(memory.id, embeddingText, "document", input.org_id);
    }

    // Step 7: Extract entities and build knowledge graph (fire-and-forget)
    this.entityExtraction.extractAndLink(memory.id, input.content, input.org_id, allTags).catch((err: unknown) => {
      logger.warn("Entity extraction failed (non-blocking)", {
        memory_id: memory.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return {
      ...memory,
      dedup_action: dedupResult.action === "supersede" ? "superseded_old" : "created",
    };
  }

  /**
   * Upsert an existing memory found by external_id.
   * Re-runs the write pipeline (summary, importance, embedding) and updates the memory.
   */
  private async upsertByExternalId(
    existing: Memory,
    input: RememberInput,
    _teamId: string | null,
  ): Promise<Memory & { dedup_action: string }> {
    // Re-run the write pipeline: summary, importance, embedding
    const sampling = getSamplingService();
    const importancePromise =
      input.importance != null
        ? Promise.resolve(input.importance)
        : sampling
          ? sampling.scoreImportance(input.content, input.memory_type, input.scope)
          : Promise.resolve(scoreImportance(input.content, input.memory_type, input.scope));

    const [summary, importance] = await Promise.all([
      sampling ? sampling.summarize(input.content) : Promise.resolve(generateSummary(input.content)),
      importancePromise,
    ]);

    const prefix = this.buildEmbeddingPrefix({
      memory_type: input.memory_type,
      scope: input.scope,
      team_slug: input.team_slug,
      tags: input.tags,
      source: input.source,
    });
    const embeddingText = `${prefix} ${summary}\n${input.content}`;
    const embedding = this.asyncEmbedding ? null : await this.generateEmbedding(embeddingText);

    // Auto-extract entity tags outside transaction
    const samplingForTags = getSamplingService();
    const llmTags = samplingForTags ? await samplingForTags.extractEntities(input.content) : null;
    const autoTags = llmTags ?? this.extractEntities(input.content);
    const allTags = [...new Set([...input.tags, ...autoTags])];

    const existingUpdatedAt = new Date(existing.updated_at);

    const upsertResult = await withTransaction(async (txSql) => {
      const txProvider = () => txSql;
      const txMemories = this.memories.withSql(txProvider);
      const txAudit = this.audit.withSql(txProvider);

      // Optimistic lock: re-read to detect concurrent modification
      const fresh = await txMemories.findById(existing.id, input.org_id);
      if (!fresh || new Date(fresh.updated_at).getTime() !== existingUpdatedAt.getTime()) {
        return null;
      }

      const updated = await txMemories.update(existing.id, {
        content: input.content,
        summary,
        importance,
        embedding,
        memory_type: input.memory_type,
        scope: input.scope,
      });
      if (!updated) return null;

      await txMemories.setTags(updated.id, allTags);

      await txAudit.log({
        entry_id: updated.id,
        action: "update",
        actor: input.created_by,
        changes: {
          dedup_action: "upserted",
          external_id: input.external_id,
        },
      });

      return { ...updated, tags: allTags };
    });

    if (upsertResult) {
      this.queueSync(upsertResult.id);
      if (this.asyncEmbedding && !embedding && this.embeddingQueue) {
        this.embeddingQueue.enqueue(upsertResult.id, embeddingText, "document", input.org_id);
      }
      return { ...upsertResult, dedup_action: "upserted" };
    }

    // Concurrent modification — fall through to normal create path
    // (remove external_id to avoid unique constraint violation on retry)
    logger.warn("External ID upsert failed due to concurrent modification, falling back to create", {
      external_id: input.external_id,
      existing_id: existing.id,
    });
    return this.remember({ ...input, external_id: undefined });
  }

  /**
   * Shorthand for atomic facts.
   */
  async rememberFact(input: RememberFactInput): Promise<Memory & { dedup_action: string }> {
    return this.remember({
      content: input.fact,
      memory_type: "fact",
      scope: input.scope,
      tags: input.tags,
      team_slug: input.team_slug,
      org_id: input.org_id,
      user_id: input.user_id,
      created_by: input.created_by,
      local_only: input.local_only,
    });
  }

  /**
   * Structured ADR capture.
   */
  async rememberDecision(input: RememberDecisionInput): Promise<Memory & { dedup_action: string }> {
    const content = `# Decision: ${input.title}

## Context
${input.context}

## Decision
${input.decision}

## Rationale
${input.rationale}
${input.alternatives ? `\n## Alternatives Considered\n${input.alternatives}` : ""}

## Date
${new Date().toISOString().split("T")[0]}`;

    return this.remember({
      content,
      memory_type: "decision",
      scope: input.scope,
      tags: ["decision", "adr", ...input.tags],
      team_slug: input.team_slug,
      org_id: input.org_id,
      user_id: input.user_id,
      created_by: input.created_by,
      local_only: input.local_only,
    });
  }

  // ─── Read Tools ───

  /**
   * Smart retrieval with composite scoring.
   */
  async recall(input: RecallInput): Promise<TokenBudgetResult & { query: string; related?: ScoredMemory[] }> {
    // If team_slug is provided but doesn't exist, return empty to avoid leaking cross-team data
    let teamId: string | undefined;
    if (input.team_slug) {
      const team = await this.teams.findBySlug(input.team_slug, input.org_id);
      if (!team)
        return {
          memories: [],
          total_tokens: 0,
          truncated: false,
          query: input.query,
          related: [],
        };
      teamId = team.id;
    }

    const filters = {
      team_id: teamId,
      org_id: input.org_id,
      user_id: input.user_id,
      scope: input.scope,
      memory_type: input.memory_type,
      tags: input.tags,
    };

    // Build enriched query with context
    const queryText = input.context ? `${input.query} ${input.context}` : input.query;

    // Run FTS and embedding generation in parallel — FTS doesn't depend on embedding
    const [ftsResults, embedding] = await Promise.all([
      this.memories.searchFts(queryText, filters, input.limit * 2),
      this.generateEmbedding(queryText, "query"),
    ]);

    // Semantic search (only if embedding was generated)
    let semanticResults: RecallResult[] = [];
    if (embedding) {
      semanticResults = await this.memories.searchSemantic(embedding, filters, input.limit * 2);
    }

    if (embedding && semanticResults.length === 0 && ftsResults.length > 0) {
      logger.warn("Recall: semantic search returned 0 results while FTS found matches — memories may have NULL embeddings (run reembed_memories or re-sync)", {
        query: input.query.slice(0, 100),
        team_slug: input.team_slug,
        org_id: input.org_id,
        fts_count: ftsResults.length,
      });
    }

    // Composite scoring
    let scored = compositeScore(ftsResults, semanticResults);

    // LLM reranking (if available, refines composite order)
    const samplingForRerank = getSamplingService();
    if (samplingForRerank && scored.length > 1) {
      const reranked = await samplingForRerank.rerank(input.query, scored, input.limit);
      if (reranked) scored = reranked;
    }

    // Token budgeting
    const result = tokenBudget(scored, input.token_budget);

    // Update access stats for returned memories
    const returnedIds = result.memories.map((m) => m.id);
    if (returnedIds.length > 0) {
      this.memories.batchUpdateAccessStats(returnedIds, input.org_id).catch((err: unknown) => {
        logger.warn("Failed to update access stats", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    // 1-hop graph enrichment (Zep/Graphiti pattern)
    // Batch-fetch related memories for top results
    const related: ScoredMemory[] = [];
    if (result.memories.length > 0) {
      const topIds = result.memories.slice(0, 3).map((m) => m.id);
      const returnedIdSet = new Set(returnedIds);

      try {
        // Fetch all relations in parallel (log failures instead of silently swallowing)
        const allRelations = await Promise.all(
          topIds.map((id) =>
            this.relations.findByEntry(id, input.org_id).catch((err: unknown) => {
              logger.warn("Failed to fetch relations for graph enrichment", {
                memory_id: id,
                error: err instanceof Error ? err.message : String(err),
              });
              return [];
            }),
          ),
        );

        // Collect unique related IDs not already in results
        const relatedIdSet = new Set<string>();
        for (let i = 0; i < topIds.length; i++) {
          const rels = allRelations[i] ?? [];
          for (const rel of rels) {
            const relatedId = rel.source_id === topIds[i] ? rel.target_id : rel.source_id;
            if (!returnedIdSet.has(relatedId)) {
              relatedIdSet.add(relatedId);
            }
          }
        }

        // Single batch fetch for related memories (limit to 15 to avoid performance issues)
        if (relatedIdSet.size > 0) {
          const relatedIds = [...relatedIdSet].slice(0, 15);
          const relatedMemories = await this.memories.findActiveByIds(relatedIds);
          for (const m of relatedMemories) {
            related.push({
              id: m.id,
              summary: m.summary,
              content: m.content,
              memory_type: m.memory_type,
              scope: m.scope,
              tags: m.tags,
              importance: m.importance,
              access_count: m.access_count,
              last_accessed_at: m.last_accessed_at,
              created_at: m.created_at,
              valid_from: m.valid_from,
              valid_until: m.valid_until,
              group_id: m.group_id ?? null,
              sequence: m.sequence ?? null,
              group_type: m.group_type ?? null,
              semantic_score: 0,
              keyword_score: 0,
              composite_score: m.importance * 0.5,
            });
          }
        }
      } catch (err: unknown) {
        logger.warn("Graph enrichment failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      ...result,
      related,
      query: input.query,
    };
  }

  /**
   * Auto-retrieval for a topic or file path.
   * When topic looks like a file path or symbol, also searches by tag prefix.
   */
  async getContextFor(input: GetContextForInput): Promise<TokenBudgetResult & { topic: string }> {
    // Detect if topic is a file path or symbol for tag-based search
    const isFilePath = input.topic.includes("/") || /\.\w{1,5}$/.test(input.topic);
    const isSymbol = /^[A-Z][a-zA-Z0-9]+$/.test(input.topic) || /^[a-z][a-zA-Z0-9]*[A-Z]/.test(input.topic);

    const tagPrefixes: string[] = [];
    if (isFilePath) tagPrefixes.push(`file:${input.topic}`);
    if (isSymbol) tagPrefixes.push(`symbol:${input.topic}`);

    // Resolve team_id once before parallel operations
    const teamId = input.team_slug ? (await this.teams.findBySlug(input.team_slug, input.org_id))?.id : undefined;

    // Run recall and tag search in parallel
    const recallPromise = this.recall({
      query: input.topic,
      team_slug: input.team_slug,
      limit: input.limit,
      token_budget: input.token_budget,
      org_id: input.org_id,
      user_id: input.user_id,
    });

    const tagPromise =
      tagPrefixes.length > 0
        ? this.memories.searchByTagPrefix(
            tagPrefixes,
            {
              org_id: input.org_id,
              team_id: teamId,
              user_id: input.user_id,
            },
            input.limit,
          )
        : Promise.resolve([]);

    const [result, tagResults] = await Promise.all([recallPromise, tagPromise]);

    // Merge tag results into recall results (deduplicating by ID)
    if (tagResults.length > 0) {
      const existingIds = new Set(result.memories.map((m) => m.id));
      for (const m of tagResults) {
        if (!existingIds.has(m.id)) {
          result.memories.push({
            ...m,
            semantic_score: 0,
            keyword_score: 0,
            composite_score: m.importance * 0.8, // Tag matches score slightly below recall
            access_count: m.access_count,
            last_accessed_at: m.last_accessed_at,
          });
          existingIds.add(m.id);
        }
      }
      // Re-sort by composite score and trim to limit
      result.memories.sort((a, b) => b.composite_score - a.composite_score);
      result.memories = result.memories.slice(0, input.limit);

      // Recalculate token budget after merge to keep totals accurate
      const rebudgeted = tokenBudget(result.memories, input.token_budget);
      return { ...rebudgeted, topic: input.topic };
    }

    return { ...result, topic: input.topic };
  }

  /**
   * Fetch a specific memory by ID.
   */
  async getMemory(id: string, orgId?: string, options?: { includeInvalidated?: boolean }): Promise<Memory | null> {
    const memory = options?.includeInvalidated
      ? await this.memories.findById(id, orgId)
      : await this.memories.findActiveById(id, orgId);
    if (!memory) return null;
    await this.memories.updateAccessStats(id, orgId);
    return memory;
  }

  /**
   * Get team overview.
   */
  async getTeamOverview(teamSlug: string, orgId?: string) {
    return this.teams.getTeamSummary(teamSlug, orgId);
  }

  // ─── Management Tools ───

  /**
   * Soft-invalidate a memory.
   */
  async forget(input: ForgetInput, orgId?: string): Promise<boolean> {
    // Verify ownership (orgId filter applied at DB level)
    if (orgId) {
      const memory = await this.memories.findById(input.id, orgId);
      if (!memory) return false;
    }
    // Wrap invalidate + audit in a transaction for atomicity
    const invalidated = await withTransaction(async (txSql) => {
      const txProvider = () => txSql;
      const txMemories = this.memories.withSql(txProvider);
      const txAudit = this.audit.withSql(txProvider);

      const result = await txMemories.invalidate(input.id, orgId);
      if (result) {
        await txAudit.log({
          entry_id: input.id,
          action: "update",
          actor: input.actor,
          changes: {
            action: "forget",
            reason: input.reason,
            valid_until: new Date().toISOString(),
          },
        });
      }
      return result;
    });
    if (invalidated) {
      this.queueSync(input.id);
    }
    return invalidated;
  }

  /**
   * Supersede a memory with corrected information.
   * Invalidates old memory first to prevent dedup from merging into it,
   * then creates the corrected version with relation and audit in a transaction.
   */
  async correct(input: CorrectInput, orgId?: string): Promise<Memory | null> {
    const existing = await this.memories.findById(input.id, orgId);
    if (!existing) return null;

    // Look up team slug from team_id (so we don't lose team association)
    let teamSlug: string | undefined;
    if (existing.team_id) {
      const team = await this.teams.findById(existing.team_id);
      teamSlug = team?.slug;
    }

    // Create the new memory first, then invalidate the old one.
    // This avoids a window where neither version is visible if remember() fails.
    const result = await this.remember({
      content: input.new_content,
      memory_type: existing.memory_type,
      scope: existing.scope,
      tags: existing.tags,
      team_slug: teamSlug,
      org_id: existing.org_id,
      user_id: existing.user_id ?? undefined,
      created_by: input.actor,
      source: `corrected from ${input.id}`,
      local_only: existing.local_only,
    });

    // If policy filtered the replacement, abort without invalidating the old memory
    if (result.dedup_action === "filtered") {
      return null;
    }

    // If dedup merged the correction into another memory, handle specially:
    // - If merged into the SAME memory being corrected, the original already has
    //   the merged content, so we just need to audit it (no invalidation needed).
    // - If merged into a DIFFERENT memory, the original should remain valid.
    if (result.dedup_action === "merged") {
      await withTransaction(async (txSql) => {
        const txAudit = this.audit.withSql(() => txSql);
        await txAudit.log({
          entry_id: input.id,
          action: "update",
          actor: input.actor,
          changes: {
            action: result.id === input.id ? "correct_merged_into_self" : "correct_merged_elsewhere",
            merged_into: result.id,
            reason: input.reason,
          },
        });
      });
      return result;
    }

    // Atomically invalidate old + link new → old + audit
    await withTransaction(async (txSql) => {
      const txProvider = () => txSql;
      const txMemories = this.memories.withSql(txProvider);
      const txRelations = this.relations.withSql(txProvider);
      const txAudit = this.audit.withSql(txProvider);

      await txMemories.invalidate(input.id, orgId);

      // Link via supersedes — but only if remember's dedup didn't already create one
      if (result.dedup_action !== "superseded_old") {
        await txRelations.create(
          {
            source_id: result.id,
            target_id: input.id,
            relation_type: "supersedes",
            description: input.reason ?? "Corrected",
          },
          existing.org_id,
        );
      }

      await txAudit.log({
        entry_id: input.id,
        action: "update",
        actor: input.actor,
        changes: {
          action: "corrected",
          corrected_by: result.id,
          reason: input.reason,
        },
      });
    });

    // Queue the invalidated old memory so its valid_until propagates via sync
    this.queueSync(input.id);

    return result;
  }

  /**
   * List memories with filters.
   */
  async listMemories(input: ListMemoriesInput): Promise<Memory[]> {
    // If team_slug is provided but doesn't exist, return empty to avoid leaking cross-team data
    let teamId: string | undefined;
    if (input.team_slug) {
      const team = await this.teams.findBySlug(input.team_slug, input.org_id);
      if (!team) return [];
      teamId = team.id;
    }

    return this.memories.list({
      team_id: teamId,
      org_id: input.org_id,
      user_id: input.user_id,
      scope: input.scope,
      memory_type: input.memory_type,
      tags: input.tags,
      since: input.since,
      local_only: input.local_only,
      limit: input.limit,
      offset: input.offset,
    });
  }

  /**
   * Explicit search (vs recall which uses composite scoring).
   */
  async searchMemories(input: SearchMemoriesInput): Promise<RecallResult[]> {
    // If team_slug is provided but doesn't exist, return empty to avoid leaking cross-team data
    let teamId: string | undefined;
    if (input.team_slug) {
      const team = await this.teams.findBySlug(input.team_slug, input.org_id);
      if (!team) return [];
      teamId = team.id;
    }

    const filters = {
      team_id: teamId,
      org_id: input.org_id,
      user_id: input.user_id,
      scope: input.scope,
      memory_type: input.memory_type,
      tags: input.tags,
      local_only: input.local_only,
    };

    const [ftsResults, embedding] = await Promise.all([
      this.memories.searchFts(input.query, filters, input.limit),
      this.generateEmbedding(input.query, "query"),
    ]);

    let semanticResults: RecallResult[] = [];
    if (embedding) {
      semanticResults = await this.memories.searchSemantic(embedding, filters, input.limit);
    }

    // Reciprocal Rank Fusion (RRF) — rank-based merge that avoids
    // comparing incomparable score distributions (ts_rank vs cosine).
    const RRF_K = 60;
    const ftsRanks = new Map<string, number>();
    const ftsSorted = [...ftsResults].sort((a, b) => b.score - a.score);
    for (const [i, item] of ftsSorted.entries()) {
      ftsRanks.set(item.id, i + 1);
    }
    const semRanks = new Map<string, number>();
    const semSorted = [...semanticResults].sort((a, b) => b.score - a.score);
    for (const [i, item] of semSorted.entries()) {
      semRanks.set(item.id, i + 1);
    }

    const merged = new Map<string, RecallResult>();
    const rrfScores = new Map<string, number>();
    for (const r of ftsResults) {
      merged.set(r.id, r);
      rrfScores.set(r.id, 1 / (RRF_K + (ftsRanks.get(r.id) ?? RRF_K)));
    }
    for (const r of semanticResults) {
      const prev = rrfScores.get(r.id) ?? 0;
      rrfScores.set(r.id, prev + 1 / (RRF_K + (semRanks.get(r.id) ?? RRF_K)));
      const existing = merged.get(r.id);
      if (existing) {
        merged.set(r.id, { ...existing, match_type: "hybrid" });
      } else {
        merged.set(r.id, r);
      }
    }

    return Array.from(merged.values())
      .sort((a, b) => (rrfScores.get(b.id) ?? 0) - (rrfScores.get(a.id) ?? 0))
      .map((r) => ({ ...r, score: rrfScores.get(r.id) ?? 0 }))
      .slice(0, input.limit);
  }

  /**
   * Get memory statistics.
   */
  async getMemoryStats(orgId?: string, teamSlug?: string): Promise<MemoryStats> {
    let teamId: string | undefined;
    if (teamSlug) {
      const team = await this.teams.findBySlug(teamSlug, orgId);
      if (!team)
        return {
          total_memories: 0,
          by_type: {},
          by_scope: {},
          total_tags: 0,
          most_accessed: [],
          stale_count: 0,
        };
      teamId = team.id;
    }

    const stats = await this.memories.getStats(orgId, teamId);
    // Convert string IDs from database to branded types
    return {
      ...stats,
      most_accessed: stats.most_accessed.map((m) => ({
        ...m,
        id: toMemoryId(m.id),
      })),
    };
  }

  // ─── Relations ───

  async linkMemories(
    sourceId: string,
    targetId: string,
    relationType: RelationType,
    description?: string,
    orgId?: string,
  ) {
    // Validate both memories exist, are active, and belong to caller's org
    const [source, target] = await Promise.all([
      this.memories.findActiveById(sourceId, orgId),
      this.memories.findActiveById(targetId, orgId),
    ]);
    if (!source) throw new NotFoundError("Memory", sourceId);
    if (!target) throw new NotFoundError("Memory", targetId);
    return this.relations.create(
      {
        source_id: sourceId,
        target_id: targetId,
        relation_type: relationType,
        description,
      },
      orgId,
    );
  }

  async getRelated(memoryId: string, orgId?: string) {
    if (orgId) {
      const memory = await this.memories.findActiveById(memoryId, orgId);
      if (!memory) return [];
    }
    return this.relations.findByEntry(memoryId, orgId, { activeOnly: true });
  }

  async removeLink(sourceId: string, targetId: string, relationType: RelationType, orgId?: string): Promise<boolean> {
    return this.relations.delete(sourceId, targetId, relationType, orgId);
  }

  /**
   * Fetch all memories in an ordered group.
   *
   * @param groupId - UUID of the group
   * @param orgId - Organization ID for tenant scoping
   * @param options.window - If set with `around`, return this many memories around the given sequence
   * @param options.around - Sequence number to center the window on
   */
  async getGroupMemories(
    groupId: string,
    orgId: string,
    options?: { window?: number; around?: number },
  ): Promise<Memory[]> {
    if (options?.window !== undefined && options.around !== undefined && options.window > 0) {
      const half = Math.floor(options.window / 2);
      const seqMin = Math.max(0, options.around - half);
      const seqMax = options.around + half;
      return this.memories.findByGroupId(orgId, groupId, { seqMin, seqMax });
    }

    return this.memories.findByGroupId(orgId, groupId);
  }

  // ─── Import/Export (backward compat) ───

  async importMarkdown(
    teamSlug: string,
    markdown: string,
    author: string,
    orgId = "default",
  ): Promise<{ imported: number; errors: string[] }> {
    const sections = this.parseMarkdownSections(markdown);
    let imported = 0;
    const errors: string[] = [];

    for (const section of sections) {
      try {
        const result = await this.remember({
          content: section.content,
          memory_type: section.type as MemoryType,
          scope: "team",
          tags: section.tags,
          team_slug: teamSlug,
          org_id: orgId,
          created_by: author,
          local_only: false,
        });
        if (result.dedup_action !== "filtered") {
          imported++;
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to import "${section.title}": ${message}`);
      }
    }

    return { imported, errors };
  }

  async exportMarkdown(teamSlug: string, orgId?: string, userId?: string): Promise<string> {
    const allMemories: Memory[] = [];
    const pageSize = 200;
    let offset = 0;
    let batch: Memory[];
    do {
      batch = await this.listMemories({
        team_slug: teamSlug,
        org_id: orgId,
        user_id: userId,
        limit: pageSize,
        offset,
      });
      allMemories.push(...batch);
      offset += pageSize;
    } while (batch.length === pageSize);
    const memories = allMemories;

    const lines: string[] = [`# Memory Base: ${teamSlug}`, ""];

    const grouped = new Map<string, Memory[]>();
    for (const m of memories) {
      const group = grouped.get(m.memory_type) ?? [];
      group.push(m);
      grouped.set(m.memory_type, group);
    }

    for (const [type, typeMemories] of grouped) {
      lines.push(`## ${type.charAt(0).toUpperCase() + type.slice(1)}s`, "");
      for (const m of typeMemories) {
        lines.push(`### ${m.summary}`, "");
        if (m.tags.length > 0) lines.push(`**Tags:** ${m.tags.join(", ")}`, "");
        lines.push(
          `**Scope:** ${m.scope} | **Importance:** ${m.importance.toFixed(2)} | **Updated:** ${new Date(m.updated_at).toISOString()}`,
          "",
        );
        lines.push(m.content, "", "---", "");
      }
    }

    return lines.join("\n");
  }

  // ─── Teams & Resources (backward compat) ───

  async listTeams(orgId?: string) {
    return this.teams.listAll(orgId);
  }

  async getAllTags(orgId?: string) {
    return this.memories.getAllTags(orgId);
  }

  async getRecentChanges(teamSlug?: string, limit = 20, orgId?: string) {
    return this.audit.getRecent(Math.min(limit, 100), teamSlug, orgId);
  }

  // ─── Active Context (Letta-inspired) ───

  /**
   * Get active context block — critical knowledge always available.
   * Returns top conventions, recent decisions, and high-importance facts.
   * Inspired by Letta's "core memory blocks" pattern.
   */
  async getActiveContext(
    orgId: string,
    teamSlug?: string,
    budget = 4000,
    workingOn?: string,
    userId?: string,
  ): Promise<
    TokenBudgetResult & {
      team_slug?: string | undefined;
      related: ScoredMemory[];
    }
  > {
    let teamId: string | undefined;
    if (teamSlug) {
      const team = await this.teams.findBySlug(teamSlug, orgId);
      if (!team)
        return {
          memories: [],
          total_tokens: 0,
          truncated: false,
          related: [],
          team_slug: teamSlug,
        };
      teamId = team.id;
    }

    // Fetch high-priority memories across types in parallel
    // Include recent episodes (last 24h) for coding agent session context
    const baseFilters = {
      team_id: teamId,
      org_id: orgId,
      user_id: userId,
      limit: 10,
      offset: 0,
    };
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const [conventions, procedures, decisions, facts, recentEpisodes] = await Promise.all([
      this.memories.list({ ...baseFilters, memory_type: "convention" }),
      this.memories.list({ ...baseFilters, memory_type: "procedure" }),
      this.memories.list({ ...baseFilters, memory_type: "decision" }),
      this.memories.list({ ...baseFilters, memory_type: "fact" }),
      this.memories.list({
        ...baseFilters,
        memory_type: "episode",
        limit: 5,
        since: twentyFourHoursAgo,
      }),
    ]);

    // If working_on is specified, fetch targeted context
    let targetedMemories: Memory[] = [];
    if (workingOn) {
      try {
        const targetedResult = await this.recall({
          query: workingOn,
          team_slug: teamSlug,
          limit: 5,
          token_budget: Math.floor(budget * 0.3), // Reserve 30% of budget for targeted context
          org_id: orgId,
          user_id: userId,
        });
        // Extract Memory-compatible objects (recall returns ScoredMemory)
        targetedMemories = targetedResult.memories.map(
          (m): Memory => ({
            id: toMemoryId(m.id as unknown as string), // Convert from RecallResult.id
            content: m.content,
            summary: m.summary,
            embedding: null,
            memory_type: m.memory_type,
            scope: m.scope,
            tags: m.tags,
            org_id: toOrgId(orgId),
            team_id: teamId ? toTeamSlug(teamId) : null,
            user_id: null,
            valid_from: m.valid_from,
            valid_until: m.valid_until,
            created_at: m.created_at,
            updated_at: m.created_at,
            importance: m.importance,
            access_count: m.access_count,
            last_accessed_at: m.last_accessed_at,
            created_by: toUserId(""),
            source: null,
            external_id: null,
            supersedes: null,
            group_id: m.group_id ?? null,
            sequence: m.sequence ?? null,
            group_type: m.group_type ?? null,
            expires_at: null,
            local_only: false,
            title: m.summary,
            author: "",
            status: "active",
            type: m.memory_type,
            visibility: m.scope,
            metadata: null,
          }),
        );
      } catch (err: unknown) {
        logger.debug("Failed to fetch targeted context", {
          working_on: workingOn,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Combine, deduplicate by ID, sort by importance, and apply token budget
    const seenIds = new Set<string>();
    const combined: Memory[] = [];
    for (const m of [...conventions, ...procedures, ...decisions, ...facts, ...recentEpisodes, ...targetedMemories]) {
      if (!seenIds.has(m.id)) {
        seenIds.add(m.id);
        combined.push(m);
      }
    }
    const all: RecallResult[] = combined.map((m) => ({
      id: m.id,
      summary: m.summary,
      content: m.content,
      memory_type: m.memory_type,
      scope: m.scope,
      tags: m.tags,
      importance: m.importance,
      access_count: m.access_count,
      last_accessed_at: m.last_accessed_at,
      score: m.importance,
      match_type: "hybrid" as const,
      created_at: m.created_at,
      valid_from: m.valid_from,
      valid_until: m.valid_until,
      group_id: m.group_id ?? null,
      sequence: m.sequence ?? null,
      group_type: m.group_type ?? null,
    }));

    // Score and budget — episodes are scored lower (importance * 0.7) than conventions/decisions
    const scored: ScoredMemory[] = all
      .map((r) => ({
        ...r,
        semantic_score: 0,
        keyword_score: 0,
        composite_score: r.memory_type === "episode" ? r.importance * 0.7 : r.importance,
      }))
      .sort((a, b) => b.composite_score - a.composite_score);

    const result = tokenBudget(scored, budget);
    return { ...result, related: [], team_slug: teamSlug };
  }

  // ─── Consolidation ───

  /**
   * Background consolidation — merge similar memories, recalculate importance.
   * Designed to run as a scheduled job or on-demand.
   */
  async consolidate(orgId: string, teamSlug?: string): Promise<{ recalculated: number; errors: number }> {
    // Get all active memories for the scope
    const memories = await this.listMemories({
      org_id: orgId,
      team_slug: teamSlug,
      limit: 500,
      offset: 0,
    });

    let errors = 0;

    // Recalculate importance for stale memories (LLM if available)
    const updates: { id: string; importance: number }[] = [];
    for (const memory of memories) {
      try {
        const samplingForConsolidate = getSamplingService();
        const newImportance = samplingForConsolidate
          ? await samplingForConsolidate.scoreImportance(memory.content, memory.memory_type, memory.scope)
          : scoreImportance(memory.content, memory.memory_type, memory.scope);
        if (Math.abs(newImportance - memory.importance) > 0.1) {
          updates.push({ id: memory.id, importance: newImportance });
        }
      } catch (err: unknown) {
        errors++;
        logger.warn("Consolidation: failed to rescore memory", {
          id: memory.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Batch updates in chunks (use allSettled so one failure doesn't abort the rest)
    const CHUNK_SIZE = 20;
    let recalculated = 0;
    for (let i = 0; i < updates.length; i += CHUNK_SIZE) {
      const chunk = updates.slice(i, i + CHUNK_SIZE);
      const results = await Promise.allSettled(
        chunk.map((u) => this.memories.update(u.id, { importance: u.importance }, orgId)),
      );
      for (const r of results) {
        if (r.status === "fulfilled" && r.value !== null) {
          recalculated++;
        } else if (r.status === "rejected") {
          errors++;
          logger.warn("Consolidation: failed to update memory", {
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          });
        }
      }
    }

    logger.info("Consolidation complete", {
      org_id: orgId,
      team_slug: teamSlug,
      recalculated,
      errors,
    });
    return { recalculated, errors };
  }

  // ─── Session Digest ───

  /**
   * Extract multiple memories from a session summary.
   * Uses LLM to parse the summary into typed memories, then runs each through remember().
   */
  async digestSession(input: {
    summary: string;
    tags: string[];
    org_id: string;
    user_id?: string;
    team_slug?: string;
    created_by: string;
  }): Promise<(Memory & { dedup_action: string })[]> {
    // Try LLM-based extraction first
    const extracted = this.extractMemoriesFromSummary(input.summary);
    const results: (Memory & { dedup_action: string })[] = [];

    for (const item of extracted) {
      try {
        const result = await this.remember({
          content: item.content,
          memory_type: item.type,
          scope: "team",
          tags: [...input.tags, ...item.tags],
          org_id: input.org_id,
          user_id: input.user_id,
          team_slug: input.team_slug,
          created_by: input.created_by,
          source: "session-digest",
          local_only: false,
        });
        if (result.dedup_action !== "filtered") {
          results.push(result);
        }
      } catch (err: unknown) {
        logger.warn("Failed to create memory from session digest", {
          content: item.content.substring(0, 100),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // If no LLM or extraction failed, store the whole summary as an episode
    if (results.length === 0) {
      const result = await this.remember({
        content: input.summary,
        memory_type: "episode",
        scope: "personal",
        tags: [...input.tags, "session-summary"],
        org_id: input.org_id,
        user_id: input.user_id,
        team_slug: input.team_slug,
        created_by: input.created_by,
        source: "session-digest",
        local_only: false,
      });
      if (result.dedup_action !== "filtered") {
        results.push(result);
      }
    }

    return results;
  }

  /**
   * Extract structured memories from a session summary using heuristics.
   */
  private extractMemoriesFromSummary(summary: string): { content: string; type: MemoryType; tags: string[] }[] {
    const items: {
      content: string;
      type: MemoryType;
      tags: string[];
    }[] = [];

    const lines = summary.split("\n").filter((l) => l.trim());
    let currentBlock: string[] = [];
    let currentType: MemoryType = "episode";

    for (const line of lines) {
      const lower = line.toLowerCase().trim();

      // Detect type transitions from markdown headers or keywords
      if (lower.startsWith("## ") || lower.startsWith("### ") || lower.startsWith("- **")) {
        // Flush current block
        if (currentBlock.length > 0) {
          items.push({
            content: currentBlock.join("\n"),
            type: currentType,
            tags: [],
          });
          currentBlock = [];
        }

        // Detect type from heading
        if (lower.includes("decision") || lower.includes("decided") || lower.includes("chose")) {
          currentType = "decision";
        } else if (lower.includes("learned") || lower.includes("discovered") || lower.includes("found that")) {
          currentType = "fact";
        } else if (
          lower.includes("fix") ||
          lower.includes("resolved") ||
          lower.includes("bug") ||
          lower.includes("error")
        ) {
          currentType = "episode";
        } else if (lower.includes("convention") || lower.includes("rule") || lower.includes("standard")) {
          currentType = "convention";
        } else if (lower.includes("procedure") || lower.includes("how to") || lower.includes("steps")) {
          currentType = "procedure";
        } else {
          currentType = "episode";
        }
      }

      currentBlock.push(line);
    }

    // Flush last block
    if (currentBlock.length > 0) {
      items.push({
        content: currentBlock.join("\n"),
        type: currentType,
        tags: [],
      });
    }

    // If nothing was structured, return the whole thing as one episode
    if (items.length === 0 && summary.trim()) {
      items.push({ content: summary, type: "episode", tags: [] });
    }

    return items;
  }

  // ─── Convention Sync ───

  /**
   * Parse a conventions document into typed memories and store them.
   */
  async syncConventions(input: {
    content: string;
    source: string;
    tags: string[];
    org_id: string;
    team_slug?: string;
    created_by: string;
  }): Promise<(Memory & { dedup_action: string })[]> {
    const sections = this.parseMarkdownSections(input.content);
    const results: (Memory & { dedup_action: string })[] = [];

    for (const section of sections) {
      try {
        const result = await this.remember({
          content: section.content,
          memory_type: section.type as MemoryType,
          scope: "team",
          tags: [...input.tags, ...section.tags],
          team_slug: input.team_slug,
          org_id: input.org_id,
          created_by: input.created_by,
          source: input.source,
          local_only: false,
        });
        if (result.dedup_action !== "filtered") {
          results.push(result);
        }
      } catch (err: unknown) {
        logger.warn("Failed to sync convention section", {
          title: section.title,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }

  // ─── Memory Policy ───

  /**
   * Set memory policy for an org/team.
   */
  async setMemoryPolicy(orgId: string, teamSlug?: string, rules?: PolicyRules): Promise<MemoryPolicy> {
    let teamId: string | null = null;
    if (teamSlug) {
      const team = await this.teams.findOrCreate(teamSlug, undefined, orgId);
      teamId = team.id;
    }
    return this.policyService.setPolicy(orgId, teamId, rules ?? {});
  }

  // ─── Entity Graph Queries ───

  /**
   * Query the knowledge graph for entities and their relationships.
   */
  async queryEntities(input: {
    query: string;
    entityType?: EntityType;
    includeRelations: boolean;
    orgId: string;
    limit: number;
  }): Promise<{
    entities: {
      id: string;
      name: string;
      entity_type: string;
      memory_count: number;
      relations?: { target: string; relation: string }[];
    }[];
    memories: { id: string; summary: string; memory_type: string }[];
  }> {
    const entities = await this.entityRepo.searchByName(input.query, input.orgId, input.limit);

    const result: {
      entities: {
        id: string;
        name: string;
        entity_type: string;
        memory_count: number;
        relations?: { target: string; relation: string }[];
      }[];
      memories: { id: string; summary: string; memory_type: string }[];
    } = {
      entities: [],
      memories: [],
    };

    const memoryIds = new Set<string>();

    for (const entity of entities) {
      const entityResult: {
        id: string;
        name: string;
        entity_type: string;
        memory_count: number;
        relations?: { target: string; relation: string }[];
      } = {
        id: entity.id,
        name: entity.name,
        entity_type: entity.entity_type,
        memory_count: entity.memory_count,
      };

      if (input.includeRelations) {
        const rels = await this.entityRepo.findRelatedEntities(entity.id, input.orgId);
        entityResult.relations = rels.map((r) => ({
          target: r.source_entity_id === entity.id ? r.target_name : r.source_name,
          relation: r.relation_type,
        }));
      }

      result.entities.push(entityResult);

      // Collect linked memory IDs for all found entities
      {
        const links = await this.entityRepo.findMemoriesByEntity(entity.name, entity.entity_type, input.orgId, 5);
        for (const link of links) {
          memoryIds.add(link.memory_id);
        }
      }
    }

    // Fetch linked memories (active only — exclude invalidated)
    if (memoryIds.size > 0) {
      const memories = await this.memories.findActiveByIds([...memoryIds].slice(0, 20), input.orgId);
      result.memories = memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        memory_type: m.memory_type,
      }));
    }

    return result;
  }

  // ─── Conflict Detection ───

  /**
   * Detect potentially contradicting memories within a scope.
   */
  async detectConflicts(input: { orgId: string; teamSlug?: string; memoryType?: MemoryType; limit: number }): Promise<
    {
      a: Memory;
      b: Memory;
      similarity: number;
      reason: string;
    }[]
  > {
    const memories = await this.listMemories({
      org_id: input.orgId,
      team_slug: input.teamSlug,
      memory_type: input.memoryType,
      limit: 100,
      offset: 0,
    });

    const conflicts: {
      a: Memory;
      b: Memory;
      similarity: number;
      reason: string;
    }[] = [];

    // Compare each pair (limited to avoid O(n^2) explosion)
    const subset = memories.slice(0, 50);
    for (let i = 0; i < subset.length && conflicts.length < input.limit; i++) {
      for (let j = i + 1; j < subset.length && conflicts.length < input.limit; j++) {
        const a = subset[i];
        const b = subset[j];
        if (!a || !b) continue;

        // Quick heuristic check first
        if (this.dedup.detectContradiction(a.content, b.content)) {
          conflicts.push({
            a,
            b,
            similarity: 0, // Would need embeddings for similarity
            reason: "Heuristic contradiction detected (negation patterns or version conflict)",
          });
        }
      }
    }

    return conflicts;
  }

  // ─── GDPR Purge ───

  /**
   * Hard-delete all memories for a user. IRREVERSIBLE.
   * Removes content, embeddings, tags, relations, entity links.
   * Anonymizes audit log entries.
   */
  async purgeUserMemories(
    userId: string,
    orgId: string,
  ): Promise<{
    deleted: number;
    anonymized: number;
    orphaned_entities_deleted: number;
    orphaned_relations_deleted: number;
  }> {
    return withTransaction(async (sql) => {
      // Get memory IDs first
      const memoryRows = await sql<{ id: string }[]>`
        SELECT id FROM memories
        WHERE user_id = ${userId} AND org_id = ${orgId}
      `;
      const memoryIds = memoryRows.map((r) => r.id);

      if (memoryIds.length === 0) {
        return {
          deleted: 0,
          anonymized: 0,
          orphaned_entities_deleted: 0,
          orphaned_relations_deleted: 0,
        };
      }

      // Hard-delete in order (respecting FK constraints)
      // 1. Entity links
      await sql`
        DELETE FROM memory_entities WHERE memory_id = ANY(${memoryIds})
      `;

      // 2. Relations
      await sql`
        DELETE FROM memory_relations
        WHERE source_memory_id = ANY(${memoryIds}) OR target_memory_id = ANY(${memoryIds})
      `;

      // 3. Tags
      await sql`
        DELETE FROM memory_tags WHERE memory_id = ANY(${memoryIds})
      `;

      // 4. Anonymize audit entries (don't delete — preserve audit trail structure)
      //    Anonymize both memory-linked entries AND entries where this user was the actor
      const [auditResult] = await sql<{ count: number }[]>`
        WITH updated AS (
          UPDATE audit_log
          SET memory_id = NULL, actor = 'purged', changes = '{}'::jsonb
          WHERE memory_id = ANY(${memoryIds}) OR actor = ${userId}
          RETURNING id
        )
        SELECT COUNT(*)::int AS count FROM updated
      `;
      const anonymized = auditResult?.count ?? 0;

      // 5. Hard-delete memories (not soft-delete)
      await sql`
        DELETE FROM memories WHERE id = ANY(${memoryIds})
      `;

      // 6. Purge orphaned entities and entity_relations
      const orphanedResult = await this.entityRepo.withSql(() => sql).purgeOrphanedEntities(orgId);

      logger.info("GDPR purge completed", {
        user_id: userId,
        org_id: orgId,
        deleted: memoryIds.length,
        anonymized,
        orphaned_entities_deleted: orphanedResult.entities_deleted,
        orphaned_relations_deleted: orphanedResult.relations_deleted,
      });

      return {
        deleted: memoryIds.length,
        anonymized,
        orphaned_entities_deleted: orphanedResult.entities_deleted,
        orphaned_relations_deleted: orphanedResult.relations_deleted,
      };
    });
  }

  // ─── Analytics ───

  /**
   * Extended analytics for memory usage.
   */
  async getAnalytics(
    orgId: string,
    teamSlug?: string,
    days = 30,
  ): Promise<{
    total_memories: number;
    created_last_period: number;
    by_type: Record<string, number>;
    by_scope: Record<string, number>;
    by_creator: { creator: string; count: number }[];
    most_accessed: { id: string; summary: string; access_count: number }[];
    stale_memories: number;
    avg_importance: number;
    total_entities: number;
    total_relations: number;
  }> {
    const db = getDb();
    const stats = await this.getMemoryStats(orgId, teamSlug);

    let teamId: string | undefined;
    if (teamSlug) {
      const team = await this.teams.findBySlug(teamSlug, orgId);
      if (!team) {
        return {
          total_memories: 0,
          created_last_period: 0,
          by_type: {},
          by_scope: {},
          by_creator: [],
          most_accessed: [],
          stale_memories: 0,
          avg_importance: 0,
          total_entities: 0,
          total_relations: 0,
        };
      }
      teamId = team.id;
    }

    const orgFilter = db`AND org_id = ${orgId}`;
    const teamFilter = teamId ? db`AND team_id = ${teamId}` : db``;
    const filters = db`${orgFilter} ${teamFilter}`;

    const sinceDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [createdRows, creatorRows, importanceRows, entityRows, relRows] = await Promise.all([
      db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL
          AND created_at >= ${sinceDate}::timestamptz ${filters}
      `,
      db<{ creator: string; count: number }[]>`
        SELECT created_by AS creator, COUNT(*)::int AS count FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL ${filters}
        GROUP BY created_by ORDER BY count DESC LIMIT 10
      `,
      db<{ avg: string }[]>`
        SELECT AVG(importance)::text AS avg FROM memories
        WHERE deleted_at IS NULL AND valid_until IS NULL ${filters}
      `,
      db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM entities WHERE org_id = ${orgId}
      `,
      db<{ count: number }[]>`
        SELECT COUNT(*)::int AS count FROM entity_relations er
        JOIN entities e ON e.id = er.source_entity_id AND e.org_id = ${orgId}
      `,
    ]);

    return {
      total_memories: stats.total_memories,
      created_last_period: createdRows[0]?.count ?? 0,
      by_type: stats.by_type,
      by_scope: stats.by_scope,
      by_creator: creatorRows,
      most_accessed: stats.most_accessed.slice(0, 5).map((m) => ({
        id: m.id,
        summary: m.summary,
        access_count: m.access_count,
      })),
      stale_memories: stats.stale_count,
      avg_importance: parseFloat(importanceRows[0]?.avg ?? "0") || 0,
      total_entities: entityRows[0]?.count ?? 0,
      total_relations: relRows[0]?.count ?? 0,
    };
  }

  // ─── Re-embedding ───

  /**
   * Re-embed all active memories using the current embedding provider.
   * Processes in batches to avoid memory pressure and rate limits.
   * Returns { processed, failed, total }.
   */
  async reembedMemories(
    orgId?: string,
    batchSize = 50,
    nullOnly = false,
  ): Promise<{ processed: number; failed: number; total: number }> {
    const provider = getEmbeddingProvider();
    let processed = 0;
    let failed = 0;
    let afterId: string | undefined;

    logger.info("Starting re-embedding migration", {
      provider: provider.name,
      org_id: orgId,
      batch_size: batchSize,
      null_only: nullOnly,
    });

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- intentional infinite loop with break
    while (true) {
      const batch = await this.memories.listForReembedding(batchSize, afterId, orgId, nullOnly);
      if (batch.length === 0) break;

      for (const memory of batch) {
        try {
          const tags = parseJsonTags(memory._tags);
          const reembedPrefix = this.buildEmbeddingPrefix({
            memory_type: memory.memory_type,
            scope: memory.scope,
            tags,
            source: memory.source ?? undefined,
          });
          const embeddingText = `${reembedPrefix} ${memory.summary}\n${memory.content}`;
          const embedding = await provider.embed(embeddingText, "document");

          // Skip no-op embeddings (all zeros)
          if (embedding.every((v) => v === 0)) {
            failed++;
            continue;
          }

          await this.memories.update(memory.id, { embedding }, orgId);
          processed++;
        } catch (err: unknown) {
          logger.warn("Failed to re-embed memory", {
            memory_id: memory.id,
            error: err instanceof Error ? err.message : String(err),
          });
          failed++;
        }
      }

      const lastItem = batch[batch.length - 1];
      if (lastItem) afterId = lastItem.id;
      logger.info("Re-embedding batch complete", {
        processed,
        failed,
        last_id: afterId,
      });
    }

    const total = processed + failed;
    logger.info("Re-embedding migration complete", {
      processed,
      failed,
      total,
    });
    return { processed, failed, total };
  }

  // ─── Helpers ───

  /**
   * Build a contextual prefix for embedding text.
   * Prepending structured metadata (type, team, source, file tags) to content
   * before embedding improves retrieval quality by 35-67% (Anthropic research).
   */
  private buildEmbeddingPrefix(params: {
    memory_type: string;
    scope: string;
    team_slug?: string | undefined;
    tags?: string[] | undefined;
    source?: string | undefined;
  }): string {
    const parts: string[] = [`[${params.memory_type}]`];
    if (params.team_slug) parts.push(`[team:${params.team_slug}]`);
    const repoTag = params.tags?.find((t) => t.startsWith("repo:"));
    if (repoTag) parts.push(`[${repoTag}]`);
    const fileTags = params.tags?.filter((t) => t.startsWith("file:"));
    if (fileTags && fileTags.length > 0) {
      parts.push(`[${fileTags.map((t) => t.replace("file:", "")).join(", ")}]`);
    }
    if (params.source) parts.push(`[source:${params.source}]`);
    return parts.join(" ");
  }

  private async generateEmbedding(text: string, purpose: EmbeddingPurpose = "document"): Promise<number[] | null> {
    try {
      const provider = getEmbeddingProvider();
      const result = await provider.embed(text, purpose);
      // Detect no-op provider (all zeros) — expected when no embedding provider configured
      if (result.every((v) => v === 0)) return null;
      return result;
    } catch (err: unknown) {
      logger.warn("Embedding generation failed. Dedup and semantic search are degraded for this operation.", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private parseMarkdownSections(markdown: string): {
    title: string;
    content: string;
    type: string;
    tags: string[];
  }[] {
    const sections: {
      title: string;
      content: string;
      type: string;
      tags: string[];
    }[] = [];

    // Split on ### headings (individual memories) rather than ## (type groups)
    const blocks = markdown.split(/^### /gm).filter(Boolean);

    for (const block of blocks) {
      const lines = block.trim().split("\n");
      const title = lines[0]?.trim();
      if (!title) continue;

      // Strip metadata lines and separators from content
      const contentLines = lines.slice(1).filter((line) => {
        const trimmed = line.trim();
        if (trimmed === "---") return false;
        if (/^\*\*Tags:\*\*/i.test(trimmed)) return false;
        if (/^\*\*Scope:\*\*/i.test(trimmed)) return false;
        return true;
      });
      const content = contentLines.join("\n").trim();
      if (!content) continue;

      const type = this.inferType(title, content);
      // Extract tags from the original block (before stripping metadata)
      const rawContent = lines.slice(1).join("\n");
      const tags = this.extractTags(rawContent);

      sections.push({ title, content, type, tags });
    }

    return sections;
  }

  private inferType(title: string, content: string): string {
    const lower = (title + " " + content).toLowerCase();
    if (lower.includes("runbook") || lower.includes("playbook")) return "procedure";
    if (lower.includes("decision") || lower.includes("adr")) return "decision";
    if (lower.includes("process") || lower.includes("workflow")) return "procedure";
    if (lower.includes("convention") || lower.includes("standard")) return "convention";
    if (lower.includes("pattern")) return "reference";
    if (lower.includes("glossary") || lower.includes("definition")) return "fact";
    if (lower.includes("faq") || lower.includes("question")) return "fact";
    return "reference";
  }

  private extractTags(content: string): string[] {
    const match = /\*\*Tags:\*\*\s*(.+)/i.exec(content);
    if (!match?.[1]) return [];
    return match[1]
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /**
   * Code-aware entity/tag extraction from content.
   * Extracts file paths, symbols, packages, env vars, error patterns,
   * API endpoints, languages, tech names, and service names.
   */
  private extractEntities(content: string): string[] {
    const entities = new Set<string>();

    // Strip URLs before file path extraction to avoid false positives
    const contentNoUrls = content.replace(/https?:\/\/\S+/g, "");

    // File paths (e.g., src/services/memory.service.ts, ./config.json)
    const filePathPattern = /(?:^|\s|`|"|\()((?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w.-]+\.[\w]+)/gm;
    for (const match of contentNoUrls.matchAll(filePathPattern)) {
      if (match[1]) entities.add(`file:${match[1]}`);
    }

    // Package names (e.g., @modelcontextprotocol/sdk, express, lodash)
    // Note: \b doesn't work before @ (not a word char), so use lookbehind for whitespace/start
    const pkgPattern = /(?:^|[\s"'`(])(@[\w-]+\/[\w.-]+)|(?:npm|yarn|pnpm)\s+(?:install|add)\s+([\w@/.-]+)/g;
    for (const match of content.matchAll(pkgPattern)) {
      const pkg = (match[1] ?? match[2] ?? "").trim();
      if (pkg && (pkg.startsWith("@") || (pkg.length > 2 && !pkg.includes("/")))) {
        entities.add(`pkg:${pkg}`);
      }
    }
    // Catch import/require statements (require `import` keyword for `from` to avoid English prose)
    const importPattern = /(?:import\s.*\bfrom|require\()\s*["'`]([^"'`\s]+)["'`]/g;
    for (const match of content.matchAll(importPattern)) {
      const mod = match[1];
      if (mod && (mod.startsWith("@") || (!mod.startsWith(".") && !mod.startsWith("/")))) {
        entities.add(`pkg:${mod}`);
      }
    }

    // Environment variables — require context signal (process.env., env., or known env var patterns)
    const envContextPattern = /(?:process\.env\.|env\.|ENV\[|export\s+)([A-Z][A-Z0-9_]{2,})\b/g;
    for (const match of content.matchAll(envContextPattern)) {
      if (match[1]) entities.add(`env:${match[1]}`);
    }
    // Also catch well-known env var patterns (with underscore, excluding SQL/common keywords)
    const envPattern = /\b([A-Z][A-Z0-9_]{2,})\b/g;
    const envExclusions =
      /^(TODO|FIXME|NOTE|HACK|WARNING|DANGER|IMPORTANT|CRITICAL|BEGIN|COMMIT|SELECT\w*|INSERT\w*|UPDATE\w*|DELETE\w*|CREATE\w*|ALTER\w*|DROP\w*|INDEX\w*|TABLE\w*|WHERE\w*|FROM\w*|NULL|TRUE|FALSE|MAX_\w+|MIN_\w+|DEFAULT_\w+|BATCH_\w+|TYPE_\w+|CONTENT_\w+|STATUS_\w+|ERROR_\w+|TEST_\w+|MOCK_\w+)$/;
    for (const match of content.matchAll(envPattern)) {
      const val = match[1];
      if (val && val.includes("_") && !envExclusions.test(val)) {
        entities.add(`env:${val}`);
      }
    }

    // Error patterns — specific errno-style codes (7+ total chars to avoid ENUM/ERROR/EXPORT/EXCEPT/etc.)
    const errorPattern = /\b(E[A-Z]{6,}[\w]*|ERR_[A-Z_]+|HTTP\s*[45]\d{2})\b/g;
    for (const match of content.matchAll(errorPattern)) {
      if (match[1]) entities.add(`error:${match[1].replace(/\s+/g, " ")}`);
    }

    // API endpoints (HTTP methods + paths)
    const apiPattern = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\/[\w/:.*{}-]+)/g;
    for (const match of content.matchAll(apiPattern)) {
      if (match[1] && match[2]) entities.add(`api:${match[1]} ${match[2]}`);
    }

    // Function/class/symbol names (PascalCase or camelCase identifiers)
    const symbolPattern = /\b(?:class|function|interface|type|enum|const|export)\s+([A-Z][\w]*)\b/g;
    for (const match of content.matchAll(symbolPattern)) {
      if (match[1]) entities.add(`symbol:${match[1]}`);
    }
    // Method names in prose (e.g., "the handleRequest() method")
    const methodPattern = /\b([a-z][\w]*(?:[A-Z][\w]*))\(\)/g;
    for (const match of content.matchAll(methodPattern)) {
      if (match[1] && match[1].length > 3) {
        entities.add(`symbol:${match[1]}`);
      }
    }

    // Programming languages (removed JSON — it's a data format, handled by tech pattern)
    const langPattern =
      /\b(TypeScript|JavaScript|Python|Java|Go|Rust|Ruby|C\+\+|C#|Swift|Kotlin|Scala|PHP|Perl|Haskell|Elixir|Clojure|Dart|Lua|Shell|Bash|SQL|HTML|CSS|YAML|TOML)\b/gi;
    for (const match of content.matchAll(langPattern)) {
      if (match[1]) entities.add(`lang:${match[1].toLowerCase()}`);
    }

    // Technology names (no prefix for backward compatibility)
    const techPatterns =
      /\b(PostgreSQL|MySQL|Redis|MongoDB|DynamoDB|Kafka|RabbitMQ|Elasticsearch|GraphQL|gRPC|REST|HTTP|WebSocket|Docker|Kubernetes|Terraform|AWS|GCP|Azure|S3|EC2|Lambda|ECS|EKS|RDS|SQS|SNS|CloudFront|Route53|IAM|Node\.js|React|Next\.js|Express|FastAPI|Spring|Django|Flask|Git|GitHub|Jenkins|Spinnaker|Datadog|Prometheus|Grafana|PagerDuty|Slack|Jira|Confluence|PGlite|pgvector|Vitest|ESLint|Prettier|Zod|JSON)\b/gi;
    for (const match of content.matchAll(techPatterns)) {
      if (match[1]) entities.add(match[1].toLowerCase());
    }

    // Service name patterns — require service-like suffix to avoid CSS props and English words
    const servicePatterns =
      /\b([a-z][a-z0-9]+-(?:service|api|worker|gateway|proxy|handler|controller|manager|daemon|server|client|agent|queue|cache|store|db|mcp))\b/g;
    for (const match of content.matchAll(servicePatterns)) {
      if (match[1] && match[1].length > 3 && match[1].length < 40) {
        entities.add(match[1]);
      }
    }

    return Array.from(entities).slice(0, 30);
  }

  /**
   * Resolve a team slug to its UUID, creating the team if it doesn't exist.
   */
  async resolveTeamId(slug: string, orgId?: string): Promise<string> {
    const team = await this.teams.findOrCreate(slug, undefined, orgId);
    return team.id;
  }

  // --- Memory Blocks ---

  async updateMemoryBlock(
    name: string,
    content: string,
    operation: "replace" | "append" | "prepend",
    orgId: string,
    teamId: string | null,
    userId: string | null,
    maxTokens: number,
  ): Promise<{
    name: string;
    content: string;
    max_tokens: number;
    updated_at: Date;
  }> {
    const db = getDb();

    if (operation === "replace") {
      const [row] = await db<
        {
          name: string;
          content: string;
          max_tokens: number;
          updated_at: Date;
        }[]
      >`
        INSERT INTO memory_blocks (id, org_id, team_id, user_id, name, content, max_tokens)
        VALUES (gen_random_uuid(), ${orgId}, ${teamId}, ${userId}, ${name}, ${content}, ${maxTokens})
        ON CONFLICT (org_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(user_id, ''), name)
        DO UPDATE SET content = ${content}, max_tokens = ${maxTokens}, updated_at = now()
        RETURNING name, content, max_tokens, updated_at
      `;
      if (!row) throw new Error(`Failed to upsert memory block "${name}"`);
      return row;
    }

    // append or prepend — use database-side concatenation to avoid race conditions.
    // Two separate parameterized queries to avoid string interpolation in SQL.
    if (operation === "append") {
      const [row] = (await db.unsafe(
        `INSERT INTO memory_blocks (id, org_id, team_id, user_id, name, content, max_tokens)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(user_id, ''), name)
         DO UPDATE SET content = COALESCE(memory_blocks.content, '') || E'\\n' || EXCLUDED.content, max_tokens = $6, updated_at = now()
         RETURNING name, content, max_tokens, updated_at`,
        [orgId, teamId, userId, name, content, maxTokens],
      )) as {
        name: string;
        content: string;
        max_tokens: number;
        updated_at: Date;
      }[];
      if (!row) throw new Error(`Failed to upsert memory block "${name}"`);
      return row;
    }

    // prepend
    const [row] = (await db.unsafe(
      `INSERT INTO memory_blocks (id, org_id, team_id, user_id, name, content, max_tokens)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
       ON CONFLICT (org_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(user_id, ''), name)
       DO UPDATE SET content = EXCLUDED.content || E'\\n' || COALESCE(memory_blocks.content, ''), max_tokens = $6, updated_at = now()
       RETURNING name, content, max_tokens, updated_at`,
      [orgId, teamId, userId, name, content, maxTokens],
    )) as {
      name: string;
      content: string;
      max_tokens: number;
      updated_at: Date;
    }[];
    if (!row) throw new Error(`Failed to upsert memory block "${name}"`);
    return row;
  }

  async listMemoryBlocks(
    orgId: string,
    teamId: string | null,
    userId: string | null,
  ): Promise<
    {
      name: string;
      content: string;
      max_tokens: number;
      updated_at: Date;
    }[]
  > {
    const db = getDb();
    return db<{ name: string; content: string; max_tokens: number; updated_at: Date }[]>`
      SELECT name, content, max_tokens, updated_at FROM memory_blocks
      WHERE org_id = ${orgId}
        AND team_id IS NOT DISTINCT FROM ${teamId}
        AND user_id IS NOT DISTINCT FROM ${userId}
      ORDER BY name
    `;
  }

  async deleteMemoryBlock(name: string, orgId: string, teamId: string | null, userId: string | null): Promise<boolean> {
    const db = getDb();
    const [row] = await db`
      DELETE FROM memory_blocks
      WHERE org_id = ${orgId}
        AND team_id IS NOT DISTINCT FROM ${teamId}
        AND user_id IS NOT DISTINCT FROM ${userId}
        AND name = ${name}
      RETURNING id
    `;
    return !!row;
  }
}

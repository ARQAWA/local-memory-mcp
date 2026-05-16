import { z } from "zod";
import type { MemoryId, OrgId, UserId, TeamSlug } from "./branded.js";

// --- Memory Types (cognitive classification) ---

export const memoryTypes = [
  "fact", // Atomic truth: "Service X uses PostgreSQL 15"
  "decision", // Recorded choice + rationale: "We chose gRPC because..."
  "procedure", // How-to knowledge: runbooks, processes, conventions
  "episode", // Past experience: "Last time we saw error X, we did Y"
  "reference", // Long-form doc: architecture overview, onboarding guide
  "convention", // Team/org coding conventions, auto-injectable into agent context
] as const;

export const memoryScopes = [
  "personal", // Individual user's memories
  "team", // Team-scoped
  "org", // Organization-wide
  "public", // Globally accessible
] as const;

// Keep relation types, add new ones
export const relationTypes = [
  "supersedes",
  "depends_on",
  "related_to",
  "implements",
  "alternative_to",
  "contradicts",
] as const;

export const matchTypes = ["semantic", "fts", "hybrid"] as const;

export const MemoryTypeSchema = z.enum(memoryTypes);
export const MemoryScopeSchema = z.enum(memoryScopes);
export const RelationTypeSchema = z.enum(relationTypes);

export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export type RelationType = z.infer<typeof RelationTypeSchema>;

// --- Legacy metadata shape (populated by repository from typed fields) ---

export type MemoryMetadata = Readonly<Record<string, string | number | boolean | null>>;

// --- Shared field schemas for reuse ---

/** Single tag: non-empty, max 200 chars. Exported for use in tool inputSchemas. */
export const tagSchema = z.string().min(1).max(200);
/** Tags array with dedup-safe defaults. Exported for use in tool inputSchemas. */
export const tagsArraySchema = z.array(tagSchema).max(100).default([]);
/** Optional tags filter (for query/filter parameters). */
export const tagsFilterSchema = z.array(z.string().min(1)).optional();
const teamSlugSchema = z.string().min(1).max(100).optional();
const orgIdSchema = z.string().min(1).max(200).default("default");
const userIdSchema = z.string().min(1).max(200).optional();
const contentSchema = z.string().min(1).max(100_000);
const querySchema = z.string().min(1).max(10_000);
const reasonSchema = z.string().max(5_000).optional();

// --- Memory Entity ---

export interface Memory {
  id: MemoryId;

  // Content
  content: string;
  summary: string;
  embedding?: number[] | null;

  // Classification
  memory_type: MemoryType;
  scope: MemoryScope;
  tags: string[];

  // Scoping
  org_id: OrgId;
  team_id: TeamSlug | null;
  user_id: UserId | null;

  // Temporal (bi-temporal model)
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
  updated_at: Date;

  // TTL (auto-expiration)
  expires_at: Date | null;

  // Relevance signals
  importance: number;
  access_count: number;
  last_accessed_at: Date;

  // Provenance
  created_by: UserId;
  source: string | null;

  // External ID for idempotent ingestion
  external_id: string | null;

  // Linking
  supersedes: MemoryId | null;

  // Legacy/mirror columns (populated by repository from memory_type/scope/summary)
  title: string;
  author: string;
  status: string | null;
  type: string | null;
  visibility: string | null;
  metadata: MemoryMetadata | string | null;

  // Group sequence (optional — for ordered memory groups)
  group_id: string | null;
  sequence: number | null;
  group_type: string | null;

  // Sync exclusion — if true, this memory is never pushed to cloud
  local_only: boolean;

  // CRDT sync metadata (optional — only present when sync is active)
  hlc?: string | null;
  hlc_wall?: number | null;
  field_hlcs?: Partial<Record<string, string>> | null;
  deleted_at?: string | Date | null;
}

// --- Zod Schemas for Tool Input Validation ---

export const RememberSchema = z
  .object({
    content: contentSchema.describe("The knowledge to remember (markdown)"),
    memory_type: MemoryTypeSchema.describe(
      "Type of memory: fact, decision, procedure, episode, reference, or convention",
    ),
    scope: MemoryScopeSchema.default("team").describe("Visibility scope: personal, team, org, or public"),
    tags: tagsArraySchema.describe("Classification tags"),
    importance: z.number().min(0).max(1).optional().describe("Importance score (0-1), auto-calculated if omitted"),
    team_slug: teamSlugSchema.describe("Team slug (required for team/org scope)"),
    org_id: orgIdSchema.describe("Organization ID"),
    user_id: userIdSchema.describe("User ID (required for personal scope)"),
    external_id: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe(
        "Stable external identifier for idempotent ingestion. If provided, upserts instead of creating duplicates.",
      ),
    source: z.string().min(1).max(500).optional().describe("Where this knowledge came from"),
    ttl_days: z
      .number()
      .int()
      .min(1)
      .max(3650)
      .optional()
      .describe("Auto-expire after this many days (e.g. 7 for weekly, 90 for quarterly). Omit for permanent."),
    group_id: z
      .uuid()
      .optional()
      .describe(
        "Group UUID to associate this memory with an ordered sequence (e.g., document chunks, conversation thread)",
      ),
    sequence: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Position within the group (0-based). Required when group_id is set."),
    group_type: z
      .string()
      .min(1)
      .max(50)
      .optional()
      .describe('Type of group (e.g., "document", "conversation", "thread", "procedure")'),
    created_by: z.string().min(1).max(200).default("agent").describe("Who is recording this"),
    local_only: z.boolean().default(false).describe("If true, this memory stays local and is never synced to cloud"),
  })
  .strict()
  .refine((data) => !(data.sequence !== undefined && !data.group_id), {
    message: "group_id is required when sequence is provided",
    path: ["group_id"],
  })
  .refine((data) => !(data.group_id !== undefined && data.sequence === undefined), {
    message: "sequence is required when group_id is provided",
    path: ["sequence"],
  })
  .refine((data) => !(data.group_type !== undefined && !data.group_id), {
    message: "group_id is required when group_type is provided",
    path: ["group_id"],
  });

export const RememberFactSchema = z
  .object({
    fact: contentSchema.describe("The atomic fact to remember"),
    tags: tagsArraySchema.describe("Classification tags"),
    scope: MemoryScopeSchema.default("team").describe("Visibility scope"),
    team_slug: teamSlugSchema.describe("Team slug"),
    org_id: orgIdSchema.describe("Organization ID"),
    user_id: userIdSchema.describe("User ID for personal facts"),
    created_by: z.string().min(1).max(200).default("agent").describe("Who is recording this"),
    local_only: z.boolean().default(false).describe("If true, this memory stays local and is never synced to cloud"),
  })
  .strict();

export const RememberDecisionSchema = z
  .object({
    title: z.string().min(1).max(500).describe("Decision title"),
    context: contentSchema.describe("What issue or context prompted this decision?"),
    decision: contentSchema.describe("What was decided and why?"),
    rationale: contentSchema.describe("Detailed rationale for the decision"),
    alternatives: z.string().max(100_000).optional().describe("Alternatives that were considered"),
    tags: tagsArraySchema.describe("Classification tags"),
    scope: MemoryScopeSchema.default("team").describe("Visibility scope"),
    team_slug: teamSlugSchema.describe("Team slug"),
    org_id: orgIdSchema.describe("Organization ID"),
    user_id: z.string().min(1).max(200).optional().describe("User ID (required for personal scope)"),
    created_by: z.string().min(1).max(200).default("agent").describe("Who is recording this"),
    local_only: z.boolean().default(false).describe("If true, this memory stays local and is never synced to cloud"),
  })
  .strict();

export const RecallSchema = z
  .object({
    query: querySchema.describe("What are you looking for?"),
    context: z.string().max(10_000).optional().describe("What you're currently working on (improves relevance)"),
    scope: MemoryScopeSchema.optional().describe("Filter to a specific scope"),
    team_slug: teamSlugSchema.describe("Filter to a specific team"),
    memory_type: MemoryTypeSchema.optional().describe("Filter by memory type"),
    tags: tagsFilterSchema.describe("Filter by tags"),
    limit: z.number().int().min(1).max(50).default(10).describe("Max memories to return"),
    token_budget: z.number().int().min(100).max(64000).default(4000).describe("Max tokens in response"),
    org_id: z.string().min(1).optional().describe("Organization ID (injected from auth context)"),
    user_id: z.string().min(1).optional().describe("User ID (injected from auth context)"),
  })
  .strict();

export const GetContextForSchema = z
  .object({
    topic: querySchema.describe("Topic or file path to get context for"),
    team_slug: teamSlugSchema.describe("Team scope"),
    limit: z.number().int().min(1).max(20).default(10).describe("Max memories"),
    token_budget: z.number().int().min(100).max(64000).default(4000).describe("Max tokens in response"),
    org_id: z.string().min(1).optional().describe("Organization ID (injected from auth context)"),
    user_id: z.string().min(1).optional().describe("User ID (injected from auth context)"),
  })
  .strict();

export const ForgetSchema = z
  .object({
    id: z.uuid().describe("Memory UUID to forget"),
    reason: reasonSchema.describe("Why this memory is being forgotten"),
    actor: z.string().min(1).max(200).default("agent").describe("Who is forgetting this"),
  })
  .strict();

export const CorrectSchema = z
  .object({
    id: z.uuid().describe("Memory UUID to correct"),
    new_content: contentSchema.describe("Corrected content"),
    reason: reasonSchema.describe("Why this correction is being made"),
    actor: z.string().min(1).max(200).default("agent").describe("Who is making the correction"),
  })
  .strict();

export const ListMemoriesSchema = z
  .object({
    scope: MemoryScopeSchema.optional().describe("Filter by scope"),
    memory_type: MemoryTypeSchema.optional().describe("Filter by memory type"),
    tags: tagsFilterSchema.describe("Filter by tags"),
    team_slug: teamSlugSchema.describe("Filter by team"),
    since: z.iso.datetime({ offset: true }).optional().describe("Only memories created after this ISO date"),
    limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
    offset: z.number().int().min(0).default(0).describe("Pagination offset"),
    local_only: z.boolean().optional().describe("Filter by local_only flag (true = only local, false = only synced)"),
    org_id: z.string().min(1).optional().describe("Organization ID (injected from auth context)"),
    user_id: z
      .string()
      .min(1)
      .optional()
      .describe("User ID (injected from auth context, for personal scope filtering)"),
  })
  .strict();

export const SearchMemoriesSchema = z
  .object({
    query: querySchema.describe("Search query"),
    scope: MemoryScopeSchema.optional().describe("Filter by scope"),
    memory_type: MemoryTypeSchema.optional().describe("Filter by memory type"),
    tags: tagsFilterSchema.describe("Filter by tags"),
    team_slug: teamSlugSchema.describe("Filter by team"),
    limit: z.number().int().min(1).max(50).default(10).describe("Max results"),
    local_only: z.boolean().optional().describe("Filter by local_only flag (true = only local, false = only synced)"),
    org_id: z.string().min(1).optional().describe("Organization ID (injected from auth context)"),
    user_id: z.string().min(1).optional().describe("User ID (injected from auth context)"),
  })
  .strict();

export const GetMemoryStatsSchema = z
  .object({
    team_slug: teamSlugSchema.describe("Filter stats by team"),
    org_id: orgIdSchema.describe("Organization ID"),
  })
  .strict();

// --- Input types ---

export type RememberInput = z.infer<typeof RememberSchema>;
export type RememberFactInput = z.infer<typeof RememberFactSchema>;
export type RememberDecisionInput = z.infer<typeof RememberDecisionSchema>;
export type RecallInput = z.infer<typeof RecallSchema>;
export type GetContextForInput = z.infer<typeof GetContextForSchema>;
export type ForgetInput = z.infer<typeof ForgetSchema>;
export type CorrectInput = z.infer<typeof CorrectSchema>;
export type ListMemoriesInput = z.infer<typeof ListMemoriesSchema>;
export type SearchMemoriesInput = z.infer<typeof SearchMemoriesSchema>;

// --- Recall result ---

export interface RecallResult {
  id: MemoryId;
  summary: string;
  content: string;
  memory_type: MemoryType;
  scope: MemoryScope;
  tags: string[];
  importance: number;
  access_count: number;
  last_accessed_at: Date;
  score: number;
  match_type: "semantic" | "fts" | "hybrid";
  created_at: Date;
  valid_from: Date;
  valid_until: Date | null;
  group_id: string | null;
  sequence: number | null;
  group_type: string | null;
}

// --- Memory Stats ---

export interface MemoryStats {
  total_memories: number;
  by_type: Record<string, number>;
  by_scope: Record<string, number>;
  total_tags: number;
  most_accessed: {
    id: MemoryId;
    summary: string;
    memory_type: string;
    access_count: number;
  }[];
  stale_count: number;
}

// --- Backward compatibility mapping ---
// Maps old entry types to new memory types
export const entryTypeToMemoryType: Record<string, MemoryType> = {
  runbook: "procedure",
  decision: "decision",
  process: "procedure",
  convention: "convention",
  pattern: "reference",
  glossary: "fact",
  contact: "fact",
  faq: "fact",
};

// Maps new memory types back to closest old entry types (for resource compatibility)
export const memoryTypeToEntryType: Record<MemoryType, string> = {
  fact: "glossary",
  decision: "decision",
  procedure: "runbook",
  episode: "faq",
  reference: "pattern",
  convention: "convention",
};

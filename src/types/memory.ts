import { z } from "zod";
import type { MemoryId, RepositoryId, UserId } from "./branded.js";

export const memoryTypes = ["fact", "decision", "procedure", "episode", "reference", "convention"] as const;

export const relationTypes = [
  "supersedes",
  "depends_on",
  "related_to",
  "implements",
  "alternative_to",
  "contradicts",
] as const;

export const matchTypes = ["semantic", "fts", "hybrid"] as const;
export const repositoryReadModes = ["current", "specific", "all"] as const;
export const graphModes = ["off", "hard", "auto", "full"] as const;
export const relatedModes = ["active", "lineage", "all"] as const;

export const MemoryTypeSchema = z.enum(memoryTypes);
export const RelationTypeSchema = z.enum(relationTypes);
export const RepositoryReadModeSchema = z.enum(repositoryReadModes);
export const GraphModeSchema = z.enum(graphModes);
export const RelatedModeSchema = z.enum(relatedModes);

export type MemoryType = z.infer<typeof MemoryTypeSchema>;
export type RelationType = z.infer<typeof RelationTypeSchema>;
export type RepositoryReadMode = z.infer<typeof RepositoryReadModeSchema>;
export type GraphMode = z.infer<typeof GraphModeSchema>;
export type RelatedMode = z.infer<typeof RelatedModeSchema>;

export type MemoryMetadata = Readonly<Record<string, string | number | boolean | null>>;

export const tagSchema = z.string().min(1).max(200);
export const tagsArraySchema = z.array(tagSchema).max(100).default([]);
export const tagsFilterSchema = z.array(z.string().min(1)).optional();
const contentSchema = z.string().min(1).max(100_000);
const querySchema = z.string().min(1).max(10_000);
const reasonSchema = z.string().max(5_000).optional();

export interface RepositoryRecord {
  id: RepositoryId;
  slug: string;
  name: string;
  root_path: string | null;
  root_hash: string;
  remote_url_hash: string | null;
  metadata: MemoryMetadata | null;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date;
  memory_count?: number;
}

export interface RepositorySelector {
  repository_mode?: RepositoryReadMode | undefined;
  repository?: string | undefined;
}

export interface Memory {
  id: MemoryId;
  repository_id: RepositoryId;
  repository_slug?: string | null;
  repository_name?: string | null;
  content: string;
  summary: string;
  embedding?: number[] | null;
  memory_type: MemoryType;
  tags: string[];
  user_id: UserId | null;
  valid_from: Date;
  valid_until: Date | null;
  created_at: Date;
  updated_at: Date;
  expires_at: Date | null;
  importance: number;
  access_count: number;
  last_accessed_at: Date;
  created_by: UserId;
  source: string | null;
  external_id: string | null;
  supersedes: MemoryId | null;
  group_id: string | null;
  sequence: number | null;
  group_type: string | null;
  deleted_at?: string | Date | null;
}

export interface RecallResult extends Memory {
  score: number;
  match_type: (typeof matchTypes)[number];
}

export interface MemoryStats {
  repository: RepositoryRecord | null;
  total: number;
  by_type: Record<string, number>;
  by_repository: Record<string, number>;
  top_tags: { tag: string; count: number }[];
  most_accessed: Memory[];
  recent_count: number;
  stale_count: number;
  avg_importance: number;
}

export const RepositorySelectorSchema = z
  .object({
    repository_mode: RepositoryReadModeSchema.default("current").describe(
      "Repository read mode. Default current. Use specific/all only on explicit request.",
    ),
    repository: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe("Repository slug or UUID. Required when repository_mode is specific."),
  })
  .strict()
  .superRefine((data, ctx) => {
    if (data.repository_mode === "specific" && !data.repository) {
      ctx.addIssue({
        code: "custom",
        message: "repository is required when repository_mode is specific",
        path: ["repository"],
      });
    }
    if (data.repository_mode !== "specific" && data.repository) {
      ctx.addIssue({
        code: "custom",
        message: "repository is only allowed when repository_mode is specific",
        path: ["repository"],
      });
    }
  });

export const RememberSchema = z
  .object({
    content: contentSchema.describe("The knowledge to remember (markdown)"),
    memory_type: MemoryTypeSchema.describe("Type: fact, decision, procedure, episode, reference, or convention"),
    tags: tagsArraySchema.describe("Classification tags"),
    importance: z.number().min(0).max(1).optional().describe("Importance score (0-1), auto-calculated if omitted"),
    external_id: z
      .string()
      .min(1)
      .max(500)
      .optional()
      .describe("Stable external identifier for idempotent ingestion within the current repository."),
    source: z.string().min(1).max(500).optional().describe("Where this knowledge came from"),
    ttl_days: z.number().int().min(1).max(3650).optional().describe("Auto-expire after this many days."),
    group_id: z.uuid().optional().describe("Group UUID for ordered memory groups."),
    sequence: z.number().int().min(0).optional().describe("Position within the group (0-based)."),
    group_type: z.string().min(1).max(50).optional().describe("Group type, e.g. document or procedure."),
    created_by: z.string().min(1).max(200).default("agent").describe("Who is recording this"),
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
    created_by: z.string().min(1).max(200).default("agent").describe("Who is recording this"),
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
    created_by: z.string().min(1).max(200).default("agent").describe("Who is recording this"),
  })
  .strict();

export const RecallSchema = RepositorySelectorSchema.extend({
  query: querySchema.describe("What are you looking for?"),
  context: z.string().max(10_000).optional().describe("What you're currently working on"),
  memory_type: MemoryTypeSchema.optional().describe("Filter by memory type"),
  tags: tagsFilterSchema.describe("Filter by tags"),
  limit: z.number().int().min(1).max(50).default(10).describe("Max memories to return"),
  token_budget: z.number().int().min(100).max(64000).default(4000).describe("Max tokens in response"),
  graph_mode: GraphModeSchema.default("hard").describe("Graph enrichment mode: off, hard, auto, or full."),
}).strict();

export const GetContextForSchema = RepositorySelectorSchema.extend({
  topic: querySchema.describe("Topic or file path to get context for"),
  limit: z.number().int().min(1).max(20).default(10).describe("Max memories"),
  token_budget: z.number().int().min(100).max(64000).default(4000).describe("Max tokens in response"),
  graph_mode: GraphModeSchema.optional().describe("Optional graph enrichment mode."),
}).strict();

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
    actor: z.string().min(1).max(200).default("agent").describe("Who is correcting this"),
  })
  .strict();

export const ListMemoriesSchema = RepositorySelectorSchema.extend({
  memory_type: MemoryTypeSchema.optional().describe("Filter by memory type"),
  tags: tagsFilterSchema.describe("Filter by tags"),
  since: z.iso.datetime({ offset: true }).optional().describe("Only memories created after this ISO date"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
  offset: z.number().int().min(0).default(0).describe("Pagination offset"),
}).strict();

export const SearchMemoriesSchema = RepositorySelectorSchema.extend({
  query: querySchema.describe("Search query"),
  memory_type: MemoryTypeSchema.optional().describe("Filter by memory type"),
  tags: tagsFilterSchema.describe("Filter by tags"),
  limit: z.number().int().min(1).max(100).default(20).describe("Max results"),
}).strict();

export const GetMemoryStatsSchema = RepositorySelectorSchema.extend({}).strict();

export type RememberInput = z.infer<typeof RememberSchema>;
export type RememberFactInput = z.infer<typeof RememberFactSchema>;
export type RememberDecisionInput = z.infer<typeof RememberDecisionSchema>;
export type RecallInput = z.infer<typeof RecallSchema>;
export type GetContextForInput = z.infer<typeof GetContextForSchema>;
export type ForgetInput = z.infer<typeof ForgetSchema>;
export type CorrectInput = z.infer<typeof CorrectSchema>;
export type ListMemoriesInput = z.infer<typeof ListMemoriesSchema>;
export type SearchMemoriesInput = z.infer<typeof SearchMemoriesSchema>;

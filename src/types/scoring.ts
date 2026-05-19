import type { MemoryType, RelationType } from "./memory.js";

export interface ScoringWeights {
  rrfK: number;
  recencyBoost: number;
  importanceBoost: number;
  frequencyBoost: number;
}

export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  rrfK: 60,
  recencyBoost: 0.3,
  importanceBoost: 0.2,
  frequencyBoost: 0.1,
};

export interface ScoredMemory {
  id: string;
  repository_id: string;
  repository_slug: string | null;
  repository_name: string | null;
  summary: string;
  content: string;
  memory_type: MemoryType;
  tags: string[];
  importance: number;
  access_count: number;
  last_accessed_at: Date;
  created_at: Date;
  valid_from: Date;
  valid_until: Date | null;
  group_id: string | null;
  sequence: number | null;
  group_type: string | null;
  semantic_score: number;
  keyword_score: number;
  composite_score: number;
  relation_source?: "memory_relations" | "shared_entity" | undefined;
  relation_type?: RelationType | "shared_entity" | undefined;
  relation_reason?: string | undefined;
  confidence?: number | undefined;
  content_mode?: "content" | "summary" | undefined;
  token_cost_estimate?: number | undefined;
}

export interface DedupResult {
  action: "create" | "merge" | "supersede";
  existing_id?: string;
  similarity?: number;
}

export interface TokenBudgetResult {
  memories: ScoredMemory[];
  total_tokens: number;
  truncated: boolean;
}

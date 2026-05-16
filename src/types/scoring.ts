import type { MemoryType, MemoryScope } from "./memory.js";

export interface ScoringWeights {
  /** RRF constant K — higher values reduce rank-position sensitivity (default: 60) */
  rrfK: number;
  /** Recency boost range: score *= (1 - recencyBoost) + recencyBoost * recencyDecay */
  recencyBoost: number;
  /** Importance boost range */
  importanceBoost: number;
  /** Frequency boost range */
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
  summary: string;
  content: string;
  memory_type: MemoryType;
  scope: MemoryScope;
  tags: string[];
  importance: number;
  access_count: number;
  last_accessed_at: Date;
  created_at: Date;
  valid_from: Date;
  valid_until: Date | null;

  // Group sequence
  group_id: string | null;
  sequence: number | null;
  group_type: string | null;

  // Individual signal scores
  semantic_score: number;
  keyword_score: number;

  // Final composite score
  composite_score: number;
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

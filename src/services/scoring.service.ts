import type { MemoryType, MemoryScope, RecallResult } from "../types/memory.js";
import type { ScoringWeights, ScoredMemory, TokenBudgetResult } from "../types/scoring.js";
import { DEFAULT_SCORING_WEIGHTS } from "../types/scoring.js";

/**
 * Heuristic importance scoring — no LLM call needed.
 */
export function scoreImportance(content: string, type: MemoryType, scope: MemoryScope): number {
  let score = 0.5;

  // Type weights
  if (type === "decision") score += 0.2;
  if (type === "procedure") score += 0.15;
  if (type === "fact") score += 0.1;
  if (type === "episode") score += 0.05;
  if (type === "reference") score += 0.1;
  if (type === "convention") score += 0.2;

  // Scope weights (broader = more important)
  if (scope === "org") score += 0.15;
  if (scope === "team") score += 0.1;
  if (scope === "public") score += 0.15;

  // Content signals
  const upper = content.toUpperCase();
  if (upper.includes("IMPORTANT") || upper.includes("CRITICAL")) score += 0.1;
  if (upper.includes("WARNING") || upper.includes("DANGER")) score += 0.05;
  if (content.length > 2000) score += 0.05;

  return Math.min(score, 1.0);
}

/**
 * Exponential recency decay using true half-life formula.
 * Returns 1.0 for now, decaying to 0.5 at halfLifeDays.
 */
export function recencyDecay(lastAccessed: Date, halfLifeDays = 30): number {
  const now = Date.now();
  const ageMs = now - lastAccessed.getTime();
  if (isNaN(ageMs)) return 0;
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  return Math.min(1.0, Math.exp((-Math.LN2 * ageDays) / halfLifeDays));
}

/**
 * Normalize access frequency to 0-1 range using log scaling.
 */
function normalizeFrequency(accessCount: number, maxCount: number): number {
  if (maxCount <= 0) return 0;
  const safeCount = Math.max(0, accessCount);
  return Math.log(1 + safeCount) / Math.log(1 + maxCount);
}

/**
 * Compute composite score using Reciprocal Rank Fusion (RRF).
 *
 * RRF merges ranked lists from different retrieval methods using:
 *   rrf_score = Σ 1/(K + rank_i)
 *
 * This is score-agnostic — it works purely on rank positions, so different
 * score distributions (cosine similarity vs ts_rank) don't cause problems.
 *
 * Recency, importance, and frequency are applied as multiplicative boosts
 * to preserve RRF's rank-fusion properties.
 */
export function compositeScore(
  ftsResults: RecallResult[],
  semanticResults: RecallResult[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): ScoredMemory[] {
  const K = weights.rrfK;

  // Build rank maps — rank 1 = best score
  const ftsRanks = new Map<string, number>();
  const ftsSorted = [...ftsResults].sort((a, b) => b.score - a.score);
  for (const [i, item] of ftsSorted.entries()) {
    ftsRanks.set(item.id, i + 1);
  }

  const semanticRanks = new Map<string, number>();
  const semanticSorted = [...semanticResults].sort((a, b) => b.score - a.score);
  for (const [i, item] of semanticSorted.entries()) {
    semanticRanks.set(item.id, i + 1);
  }

  // Build raw score lookup maps
  const ftsScores = new Map<string, number>();
  for (const r of ftsResults) {
    ftsScores.set(r.id, r.score);
  }
  const semanticScores = new Map<string, number>();
  for (const r of semanticResults) {
    semanticScores.set(r.id, r.score);
  }

  // Merge all unique results
  const merged = new Map<
    string,
    {
      result: RecallResult;
      ftsRank: number | null;
      semanticRank: number | null;
    }
  >();

  for (const r of ftsResults) {
    merged.set(r.id, {
      result: r,
      ftsRank: ftsRanks.get(r.id) ?? null,
      semanticRank: null,
    });
  }

  for (const r of semanticResults) {
    const existing = merged.get(r.id);
    if (existing) {
      existing.semanticRank = semanticRanks.get(r.id) ?? null;
    } else {
      merged.set(r.id, {
        result: r,
        ftsRank: null,
        semanticRank: semanticRanks.get(r.id) ?? null,
      });
    }
  }

  // Find max access count for frequency normalization
  const allEntries = Array.from(merged.values());
  const maxAccess = allEntries.reduce((max, m) => Math.max(max, m.result.access_count), 1);

  // Normalize FTS scores for the keyword_score field (display only)
  const maxFts = ftsResults.reduce((max, r) => Math.max(max, r.score), 0.001);

  const scored: ScoredMemory[] = allEntries.map((m) => {
    const r = m.result;

    // RRF score: sum of 1/(K + rank) for each list the result appears in
    let rrfScore = 0;
    if (m.ftsRank !== null) {
      rrfScore += 1 / (K + m.ftsRank);
    }
    if (m.semanticRank !== null) {
      rrfScore += 1 / (K + m.semanticRank);
    }

    // Multiplicative boosts for recency, importance, frequency
    const lastAccessed = new Date(r.last_accessed_at);
    const accessCount = r.access_count;
    const importance = r.importance;

    const recencyFactor = 1 - weights.recencyBoost + weights.recencyBoost * recencyDecay(lastAccessed);
    const importanceFactor = 1 - weights.importanceBoost + weights.importanceBoost * importance;
    const frequencyFactor =
      1 - weights.frequencyBoost + weights.frequencyBoost * normalizeFrequency(accessCount, maxAccess);

    const composite = rrfScore * recencyFactor * importanceFactor * frequencyFactor;

    // Preserve raw scores for display/debugging (from original score maps)
    const rawFts = ftsScores.get(r.id) ?? 0;
    const ftsScoreNorm = m.ftsRank !== null ? rawFts / maxFts : 0;
    const semanticScore = semanticScores.get(r.id) ?? 0;

    return {
      id: r.id,
      summary: r.summary,
      content: r.content,
      memory_type: r.memory_type,
      scope: r.scope,
      tags: r.tags,
      importance,
      access_count: accessCount,
      last_accessed_at: lastAccessed,
      created_at: r.created_at,
      valid_from: r.valid_from,
      valid_until: r.valid_until,
      group_id: r.group_id ?? null,
      sequence: r.sequence ?? null,
      group_type: r.group_type ?? null,
      semantic_score: semanticScore,
      keyword_score: ftsScoreNorm,
      composite_score: composite,
    };
  });

  return scored.sort((a, b) => b.composite_score - a.composite_score);
}

/**
 * Rough token estimation: ~4 characters per token for English text.
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Fill a token budget with top-scored memories.
 * Returns full content for top results, summaries for overflow.
 */
export function tokenBudget(scored: ScoredMemory[], budget: number): TokenBudgetResult {
  const result: ScoredMemory[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const memory of scored) {
    const contentTokens = estimateTokens(memory.content);
    const summaryTokens = estimateTokens(memory.summary);

    if (totalTokens + contentTokens <= budget) {
      // Full content fits
      result.push(memory);
      totalTokens += contentTokens;
    } else if (totalTokens + summaryTokens <= budget) {
      // Only summary fits — truncate content to summary
      result.push({ ...memory, content: memory.summary });
      totalTokens += summaryTokens;
      truncated = true;
    } else {
      // Budget exhausted
      truncated = true;
      break;
    }
  }

  return { memories: result, total_tokens: totalTokens, truncated };
}

/**
 * Generate a one-line summary from content.
 * Simple heuristic: first sentence or first N characters.
 */
export function generateSummary(content: string, maxLength = 200): string {
  // Try to extract first sentence
  const firstSentence = /^[^.!?\n]+[.!?]/.exec(content);
  if (firstSentence && firstSentence[0].length <= maxLength) {
    return firstSentence[0].trim();
  }

  // Fall back to first N characters
  if (content.length <= maxLength) return content.trim();
  return content.substring(0, maxLength - 3).trim() + "...";
}

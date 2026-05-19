import type { MemoryType, RecallResult } from "../types/memory.js";
import type { ScoredMemory, ScoringWeights, TokenBudgetResult } from "../types/scoring.js";
import { DEFAULT_SCORING_WEIGHTS } from "../types/scoring.js";

export function scoreImportance(content: string, type: MemoryType): number {
  let score = 0.5;
  if (type === "decision") score += 0.2;
  if (type === "procedure") score += 0.15;
  if (type === "fact") score += 0.1;
  if (type === "episode") score += 0.05;
  if (type === "reference") score += 0.1;
  if (type === "convention") score += 0.2;

  const upper = content.toUpperCase();
  if (upper.includes("IMPORTANT") || upper.includes("CRITICAL")) score += 0.1;
  if (upper.includes("WARNING") || upper.includes("DANGER")) score += 0.05;
  if (content.length > 2000) score += 0.05;
  return Math.min(score, 1);
}

export function recencyDecay(lastAccessed: Date, halfLifeDays = 30): number {
  const ageMs = Date.now() - lastAccessed.getTime();
  if (Number.isNaN(ageMs)) return 0;
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  return Math.min(1, Math.exp((-Math.LN2 * ageDays) / halfLifeDays));
}

function normalizeFrequency(accessCount: number, maxCount: number): number {
  if (maxCount <= 0) return 0;
  return Math.log(1 + Math.max(0, accessCount)) / Math.log(1 + maxCount);
}

export function compositeScore(
  ftsResults: RecallResult[],
  semanticResults: RecallResult[],
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS,
): ScoredMemory[] {
  const k = weights.rrfK;
  const ftsRanks = new Map<string, number>();
  const semanticRanks = new Map<string, number>();
  [...ftsResults].sort((a, b) => b.score - a.score).forEach((item, index) => ftsRanks.set(item.id, index + 1));
  [...semanticResults]
    .sort((a, b) => b.score - a.score)
    .forEach((item, index) => semanticRanks.set(item.id, index + 1));

  const ftsScores = new Map(ftsResults.map((r) => [r.id, r.score]));
  const semanticScores = new Map(semanticResults.map((r) => [r.id, r.score]));
  const merged = new Map<string, RecallResult>();
  for (const result of ftsResults) merged.set(result.id, result);
  for (const result of semanticResults) merged.set(result.id, result);

  const maxAccess = Array.from(merged.values()).reduce((max, item) => Math.max(max, item.access_count), 1);
  const maxFts = ftsResults.reduce((max, item) => Math.max(max, item.score), 0.001);

  return Array.from(merged.values())
    .map((result) => {
      const ftsRank = ftsRanks.get(result.id);
      const semanticRank = semanticRanks.get(result.id);
      let rrfScore = 0;
      if (ftsRank !== undefined) rrfScore += 1 / (k + ftsRank);
      if (semanticRank !== undefined) rrfScore += 1 / (k + semanticRank);

      const recencyFactor =
        1 - weights.recencyBoost + weights.recencyBoost * recencyDecay(new Date(result.last_accessed_at));
      const importanceFactor = 1 - weights.importanceBoost + weights.importanceBoost * result.importance;
      const frequencyFactor =
        1 - weights.frequencyBoost + weights.frequencyBoost * normalizeFrequency(result.access_count, maxAccess);

      return {
        id: result.id,
        repository_id: result.repository_id,
        repository_slug: result.repository_slug ?? null,
        repository_name: result.repository_name ?? null,
        summary: result.summary,
        content: result.content,
        memory_type: result.memory_type,
        tags: result.tags,
        importance: result.importance,
        access_count: result.access_count,
        last_accessed_at: new Date(result.last_accessed_at),
        created_at: new Date(result.created_at),
        valid_from: new Date(result.valid_from),
        valid_until: result.valid_until ? new Date(result.valid_until) : null,
        group_id: result.group_id ?? null,
        sequence: result.sequence ?? null,
        group_type: result.group_type ?? null,
        semantic_score: semanticScores.get(result.id) ?? 0,
        keyword_score: ftsRank !== undefined ? (ftsScores.get(result.id) ?? 0) / maxFts : 0,
        composite_score: rrfScore * recencyFactor * importanceFactor * frequencyFactor,
      };
    })
    .sort((a, b) => b.composite_score - a.composite_score);
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function tokenBudget(scored: ScoredMemory[], budget: number): TokenBudgetResult {
  const memories: ScoredMemory[] = [];
  let totalTokens = 0;
  let truncated = false;

  for (const memory of scored) {
    const contentTokens = estimateTokens(memory.content);
    const summaryTokens = estimateTokens(memory.summary);
    if (totalTokens + contentTokens <= budget) {
      memories.push(memory);
      totalTokens += contentTokens;
    } else if (totalTokens + summaryTokens <= budget) {
      memories.push({ ...memory, content: memory.summary });
      totalTokens += summaryTokens;
      truncated = true;
    } else {
      truncated = true;
      break;
    }
  }

  return { memories, total_tokens: totalTokens, truncated };
}

export function generateSummary(content: string, maxLength = 200): string {
  const firstSentence = /^[^.!?\n]+[.!?]/.exec(content);
  if (firstSentence && firstSentence[0].length <= maxLength) return firstSentence[0].trim();
  if (content.length <= maxLength) return content.trim();
  return `${content.substring(0, maxLength - 3).trim()}...`;
}

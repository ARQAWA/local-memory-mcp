import { MemoryRepository } from "../repositories/memory.repository.js";
import type { DedupResult } from "../types/scoring.js";
import { getSamplingService } from "../context.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

/**
 * Deduplication and conflict resolution for memories.
 */
export class DedupService {
  private memories: MemoryRepository;

  constructor(memories?: MemoryRepository) {
    this.memories = memories ?? new MemoryRepository();
  }

  /**
   * Check if a new memory is a duplicate of an existing one.
   * Returns action: create (novel), merge (near-duplicate), or supersede (contradiction).
   */
  async findDuplicates(
    embedding: number[] | null,
    content: string,
    threshold: number = DEFAULT_SIMILARITY_THRESHOLD,
    scope?: { org_id?: string; team_id?: string | null },
    excludeId?: string,
  ): Promise<DedupResult> {
    // If no embedding, can't do similarity search — treat as novel
    if (!embedding || embedding.every((v) => v === 0)) {
      return { action: "create" };
    }

    const similar = await this.memories.findSimilar(embedding, threshold, 3, scope, excludeId);

    if (similar.length === 0) {
      return { action: "create" };
    }

    const topMatch = similar[0];
    if (!topMatch) return { action: "create" };

    // Very high similarity = near-duplicate, merge
    if (topMatch.similarity > 0.92) {
      return {
        action: "merge",
        existing_id: topMatch.id,
        similarity: topMatch.similarity,
      };
    }

    // High similarity but content differs enough = potential update/supersede
    if (topMatch.similarity > threshold) {
      // Try LLM contradiction detection first, fall back to heuristic
      const sampling = getSamplingService();
      const llmResult = sampling ? await sampling.detectContradiction(content, topMatch.content) : null;
      const isContradiction = llmResult ?? this.detectContradiction(content, topMatch.content);

      if (isContradiction) {
        return {
          action: "supersede",
          existing_id: topMatch.id,
          similarity: topMatch.similarity,
        };
      }

      // Similar but not contradicting — merge
      return {
        action: "merge",
        existing_id: topMatch.id,
        similarity: topMatch.similarity,
      };
    }

    return { action: "create" };
  }

  /**
   * Heuristic contradiction detection.
   * Uses word-boundary matching to reduce false positives.
   * Checks for negation patterns and conflicting statements.
   */
  detectContradiction(newContent: string, existingContent: string): boolean {
    const newLower = newContent.toLowerCase();
    const existingLower = existingContent.toLowerCase();

    // Use multi-word negation pairs to reduce false positives.
    // Each pair: [negated phrase, affirmative phrase].
    // Both sides must be multi-word or use word-boundary regex to avoid
    // substring false-positives (e.g., "do" matching "docker").
    const negationPairs: [RegExp, RegExp][] = [
      [/\bshould not\b/, /\bshould\b/],
      [/\bshouldn't\b/, /\bshould\b/],
      [/\bmust not\b/, /\bmust\b/],
      [/\bdo not use\b/, /\buse\b/],
      [/\bdon't use\b/, /\buse\b/],
      [/\bnever\b/, /\balways\b/],
      [/\bdeprecated\b/, /\brecommended\b/],
      [/\bremoved\b/, /\badded\b/],
      [/\bdisabled\b/, /\benabled\b/],
      [/\bno longer\b/, /\bstill\b/],
    ];

    for (const [negPattern, posPattern] of negationPairs) {
      const newHasNeg = negPattern.test(newLower);
      const newHasPos = posPattern.test(newLower);
      const existHasNeg = negPattern.test(existingLower);
      const existHasPos = posPattern.test(existingLower);

      // One doc has the negation, the other has only the affirmative
      if ((newHasNeg && existHasPos && !existHasNeg) || (existHasNeg && newHasPos && !newHasNeg)) {
        return true;
      }
    }

    // Check for version/number changes that might indicate updates.
    // Use strict version pattern (v-prefix or x.y.z format) to avoid
    // matching decimals like "2.5 hours" or IP addresses.
    const versionPattern = /\bv?\d+\.\d+(?:\.\d+)?\b/g;
    const newVersions: string[] = Array.from(newLower.matchAll(versionPattern), (m) => m[0]);
    const existingVersions: string[] = Array.from(existingLower.matchAll(versionPattern), (m) => m[0]);

    if (newVersions.length > 0 && existingVersions.length > 0) {
      // Different versions of the same thing = likely supersedes
      // Require higher shared context (0.5) to reduce false positives
      const sharedContext = this.getSharedWords(newLower, existingLower);
      if (sharedContext > 0.5 && !newVersions.some((v) => existingVersions.includes(v))) {
        return true;
      }
    }

    return false;
  }

  /**
   * Merge two memories' content — append new information to existing.
   */
  mergeContent(existing: string, newContent: string): string {
    // Simple merge: append new content that isn't already present
    const existingLines = new Set(
      existing
        .split("\n")
        .map((l) => l.trim().toLowerCase())
        .filter(Boolean),
    );

    const newLines = newContent.split("\n").filter((l) => {
      const trimmed = l.trim().toLowerCase();
      return trimmed && !existingLines.has(trimmed);
    });

    if (newLines.length === 0) return existing;

    return `${existing}\n\n---\n*Updated:*\n${newLines.join("\n")}`;
  }

  /**
   * Calculate ratio of shared words between two texts.
   */
  private getSharedWords(a: string, b: string): number {
    const stripPunctuation = (w: string) => w.replace(/[^\w]/g, "");
    const wordsA = new Set(
      a
        .split(/\s+/)
        .map(stripPunctuation)
        .filter((w) => w.length > 3),
    );
    const wordsB = new Set(
      b
        .split(/\s+/)
        .map(stripPunctuation)
        .filter((w) => w.length > 3),
    );

    if (wordsA.size === 0 || wordsB.size === 0) return 0;

    let shared = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) shared++;
    }

    return shared / Math.min(wordsA.size, wordsB.size);
  }
}

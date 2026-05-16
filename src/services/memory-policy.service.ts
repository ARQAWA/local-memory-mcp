import { getDb } from "../db/connection.js";
import { getSamplingService } from "../context.js";
import { logger } from "./logger.js";

export interface MemoryPolicy {
  id: string;
  org_id: string;
  team_id: string | null;
  rules: PolicyRules;
  created_at: Date;
  updated_at: Date;
}

export interface PolicyRules {
  /** Natural language description of what to remember */
  remember?: string;
  /** Natural language description of what to ignore/never store */
  ignore?: string;
  /** Specific categories to auto-tag */
  categories?: string[];
  /** Max memories per day per agent (rate limiting) */
  max_per_day?: number;
}

/**
 * Selective memory rules — controls what gets remembered and what gets filtered out.
 * Per-team/org configuration evaluated during the remember() pipeline.
 */
export class MemoryPolicyService {
  private policyCache = new Map<string, { policy: MemoryPolicy | null; expiresAt: number }>();

  /**
   * Check if content should be remembered based on team/org policy.
   * Returns { allowed: true } or { allowed: false, reason: string }.
   */
  async evaluate(
    content: string,
    orgId: string,
    teamId?: string | null,
  ): Promise<{ allowed: boolean; reason?: string; suggestedTags?: string[] }> {
    const policy = await this.getPolicy(orgId, teamId);
    if (!policy) return { allowed: true };

    const rules = policy.rules;

    // If no rules defined, allow everything
    if (!rules.remember && !rules.ignore) return { allowed: true };

    // Try LLM evaluation if sampling available
    const sampling = getSamplingService();
    if (sampling) {
      return this.evaluateWithLLM(content, rules);
    }

    // Heuristic evaluation
    return this.evaluateHeuristic(content, rules);
  }

  /**
   * Get or create a policy for an org/team.
   */
  async getPolicy(orgId: string, teamId?: string | null): Promise<MemoryPolicy | null> {
    const cacheKey = `${orgId}:${teamId ?? ""}`;
    const cached = this.policyCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) return cached.policy;

    try {
      const sql = getDb();
      const teamFilter = teamId ? sql`AND team_id = ${teamId}` : sql`AND team_id IS NULL`;

      const [row] = await sql<MemoryPolicy[]>`
        SELECT * FROM memory_policies
        WHERE org_id = ${orgId} ${teamFilter}
      `;

      // SQLite returns rules as a JSON string (TEXT column), PG returns a parsed object (JSONB).
      // Normalize to a parsed object for consistent downstream access.
      if (row && typeof row.rules === "string") {
        try {
          row.rules = JSON.parse(row.rules) as PolicyRules;
        } catch {
          logger.warn("Corrupted policy JSON — falling back to empty rules", {
            org_id: orgId,
            team_id: teamId ?? null,
          });
          row.rules = {} as PolicyRules;
        }
      }
      const policy = row ?? null;

      // Evict expired entries and enforce max size before caching
      const MAX_CACHE_SIZE = 1000;
      if (this.policyCache.size >= MAX_CACHE_SIZE) {
        const now = Date.now();
        for (const [k, v] of this.policyCache) {
          if (now >= v.expiresAt) this.policyCache.delete(k);
        }
        // If still over limit, clear the oldest half
        if (this.policyCache.size >= MAX_CACHE_SIZE) {
          const keys = [...this.policyCache.keys()];
          for (let i = 0; i < keys.length / 2; i++) {
            const key = keys[i];
            if (key !== undefined) this.policyCache.delete(key);
          }
        }
      }

      this.policyCache.set(cacheKey, {
        policy,
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 min cache
      });
      return policy;
    } catch {
      // Table might not exist yet (pre-migration)
      return null;
    }
  }

  /**
   * Set policy rules for an org/team.
   */
  async setPolicy(orgId: string, teamId: string | null, rules: PolicyRules): Promise<MemoryPolicy> {
    // Invalidate cache before write to prevent stale reads during the update
    const cacheKey = `${orgId}:${teamId ?? ""}`;
    this.policyCache.delete(cacheKey);

    const sql = getDb();
    const rulesJson = JSON.stringify(rules);

    // Use partial-index-aware upsert: separate paths for NULL vs non-NULL team_id
    let row: MemoryPolicy | undefined;
    if (teamId) {
      [row] = await sql<MemoryPolicy[]>`
        INSERT INTO memory_policies (id, org_id, team_id, rules)
        VALUES (gen_random_uuid(), ${orgId}, ${teamId}, ${rulesJson}::jsonb)
        ON CONFLICT (org_id, team_id) WHERE team_id IS NOT NULL DO UPDATE
          SET rules = ${rulesJson}::jsonb, updated_at = now()
        RETURNING *
      `;
    } else {
      [row] = await sql<MemoryPolicy[]>`
        INSERT INTO memory_policies (id, org_id, team_id, rules)
        VALUES (gen_random_uuid(), ${orgId}, ${null}, ${rulesJson}::jsonb)
        ON CONFLICT (org_id) WHERE team_id IS NULL DO UPDATE
          SET rules = ${rulesJson}::jsonb, updated_at = now()
        RETURNING *
      `;
    }
    if (!row) throw new Error("Failed to set memory policy");

    // Also invalidate after write for safety
    this.policyCache.delete(cacheKey);

    return row;
  }

  /**
   * LLM-based policy evaluation.
   * Currently falls back to heuristic — sampling.sample() is private.
   * TODO: Add a dedicated policy evaluation method to SamplingService.
   */
  private evaluateWithLLM(
    content: string,
    rules: PolicyRules,
  ): { allowed: boolean; reason?: string; suggestedTags?: string[] } {
    const sampling = getSamplingService();
    if (!sampling) return { allowed: true };

    if (!sampling.isSamplingAvailable()) {
      return this.evaluateHeuristic(content, rules);
    }

    // Falls back to heuristic for now
    return this.evaluateHeuristic(content, rules);
  }

  /**
   * Heuristic policy evaluation using keyword matching.
   */
  private evaluateHeuristic(
    content: string,
    rules: PolicyRules,
  ): { allowed: boolean; reason?: string; suggestedTags?: string[] } {
    const lower = content.toLowerCase();

    // Check ignore rules
    if (rules.ignore) {
      const ignoreTerms = rules.ignore
        .toLowerCase()
        .split(/[,;]/)
        .map((t) => t.trim())
        .filter(Boolean);

      for (const term of ignoreTerms) {
        // Check for common ignore patterns
        if (term.includes("debug") && lower.includes("debug")) {
          return {
            allowed: false,
            reason: `Filtered by policy: matches ignore rule "${term}"`,
          };
        }
        if (term.includes("temp") && (lower.includes("temporary") || lower.includes("temp "))) {
          return {
            allowed: false,
            reason: `Filtered by policy: matches ignore rule "${term}"`,
          };
        }
        if (
          term.includes("credential") &&
          (lower.includes("password") ||
            lower.includes("secret") ||
            lower.includes("token") ||
            lower.includes("api_key"))
        ) {
          return {
            allowed: false,
            reason: `Filtered by policy: contains sensitive data matching "${term}"`,
          };
        }
        if (
          term.includes("pii") &&
          (lower.includes("ssn") || lower.includes("social security") || lower.includes("credit card"))
        ) {
          return {
            allowed: false,
            reason: `Filtered by policy: contains PII matching "${term}"`,
          };
        }
        // Generic keyword match — use word boundary to avoid substring false positives
        const termRegex = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
        if (term.length > 3 && termRegex.test(lower)) {
          return {
            allowed: false,
            reason: `Filtered by policy: matches ignore rule "${term}"`,
          };
        }
      }
    }

    // Auto-suggest tags from categories
    const suggestedTags: string[] = [];
    if (rules.categories) {
      for (const category of rules.categories) {
        const categoryLower = category.toLowerCase();
        if (lower.includes(categoryLower)) {
          suggestedTags.push(category);
        }
      }
    }

    return { allowed: true, suggestedTags };
  }
}

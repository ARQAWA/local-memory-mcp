/**
 * Startup check for NULL embeddings left behind by migration 010.
 *
 * Queries the count of active memories with `embedding IS NULL` and logs a
 * warning so operators know to run `reembed_memories`.
 */

import { logger } from "./logger.js";
import { getDb } from "../db/connection.js";

export interface NullEmbeddingCheckResult {
  nullCount: number;
  totalCount: number;
}

/**
 * Count memories with NULL embeddings. Returns the count so callers can
 * decide what to do (log, fix, etc.).
 */
export async function checkNullEmbeddings(): Promise<NullEmbeddingCheckResult> {
  const sql = getDb();

  const [nullRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM memories
    WHERE embedding IS NULL AND deleted_at IS NULL AND valid_until IS NULL
      AND (expires_at IS NULL OR expires_at > now())
  `;

  const [totalRow] = await sql<{ count: number }[]>`
    SELECT COUNT(*)::int AS count
    FROM memories
    WHERE deleted_at IS NULL AND valid_until IS NULL
      AND (expires_at IS NULL OR expires_at > now())
  `;

  return {
    nullCount: nullRow?.count ?? 0,
    totalCount: totalRow?.count ?? 0,
  };
}

/**
 * Run the NULL-embedding startup check. Logs a warning if any are found.
 * This is non-blocking and safe to call during startup.
 */
export async function runStartupEmbeddingCheck(): Promise<void> {
  try {
    const { nullCount, totalCount } = await checkNullEmbeddings();

    if (nullCount > 0) {
      logger.warn(
        `Found ${String(nullCount)} of ${String(totalCount)} memories without embeddings. ` +
          `Run the 'reembed_memories' admin tool with null_only=true to backfill, ` +
          `or run 'engram doctor --fix'.`,
        { nullCount, totalCount },
      );
    } else {
      logger.info("All active memories have embeddings.", { totalCount });
    }
  } catch (err: unknown) {
    // Non-fatal: don't prevent server startup if this check fails
    logger.warn("Failed to check for NULL embeddings at startup", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

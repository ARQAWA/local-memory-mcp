/**
 * Simple in-memory embedding metrics tracker.
 * Exposes counters for embedding generation success/failure rates.
 * Resets on server restart (no persistence needed).
 */

export interface EmbeddingMetrics {
  total: number;
  success: number;
  failures: number;
  queueFailures: number;
  lastFailureAt: string | null;
  lastError: string | null;
}

const metrics: EmbeddingMetrics = {
  total: 0,
  success: 0,
  failures: 0,
  queueFailures: 0,
  lastFailureAt: null,
  lastError: null,
};

export function recordEmbeddingSuccess(): void {
  metrics.total++;
  metrics.success++;
}

export function recordEmbeddingFailure(error: string): void {
  metrics.total++;
  metrics.failures++;
  metrics.lastFailureAt = new Date().toISOString();
  metrics.lastError = error;
}

export function recordQueueFailure(error: string): void {
  metrics.queueFailures++;
  metrics.lastFailureAt = new Date().toISOString();
  metrics.lastError = error;
}

export function getEmbeddingMetrics(): EmbeddingMetrics {
  return { ...metrics };
}

export function resetEmbeddingMetrics(): void {
  metrics.total = 0;
  metrics.success = 0;
  metrics.failures = 0;
  metrics.queueFailures = 0;
  metrics.lastFailureAt = null;
  metrics.lastError = null;
}

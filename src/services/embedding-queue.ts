/**
 * Async embedding queue — decouples embedding generation from the write path.
 *
 * Memories are written with embedding = NULL, then this queue processes them
 * in the background. FTS search works immediately; semantic search catches up
 * within seconds.
 *
 * Features:
 * - Batch processing (configurable batch size)
 * - Exponential backoff on failures
 * - Graceful shutdown with drain
 */

import { MemoryRepository } from "../repositories/memory.repository.js";
import { getEmbeddingProvider, type EmbeddingPurpose } from "./embedding.service.js";
import { logger } from "./logger.js";

interface QueueItem {
  memoryId: string;
  orgId?: string | undefined;
  embeddingText: string;
  purpose: EmbeddingPurpose;
  retries: number;
}

export class EmbeddingQueue {
  private queue = new Map<string, QueueItem>();
  private processing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private memories: MemoryRepository;
  private intervalMs: number;
  private batchSize: number;
  private maxRetries: number;
  private maxQueueSize: number;

  /** Optional callback invoked after a memory's embedding is successfully generated and saved. */
  onEmbeddingReady?: ((memoryId: string, embedding: number[]) => Promise<void>) | undefined;

  constructor(
    memories: MemoryRepository,
    options?: {
      intervalMs?: number;
      batchSize?: number;
      maxRetries?: number;
      maxQueueSize?: number;
    },
  ) {
    this.memories = memories;
    this.intervalMs = options?.intervalMs ?? 1000;
    this.batchSize = options?.batchSize ?? 10;
    this.maxRetries = options?.maxRetries ?? 3;
    this.maxQueueSize = options?.maxQueueSize ?? 10_000;
  }

  /** Start the background processing loop. */
  start(): void {
    this.stopped = false;
    this.timer = setInterval(() => {
      this.processQueue().catch((err: unknown) => {
        logger.warn("Embedding queue processing error", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }, this.intervalMs);
    this.timer.unref();
  }

  /** Stop the queue and drain all remaining items. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Wait for any in-flight batch to complete before draining
    const maxWait = 50; // 50 × 100ms = 5s max wait
    for (let w = 0; w < maxWait && this.processing; w++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Drain all remaining items in batches
    const maxDrainCycles = Math.ceil(this.queue.size / this.batchSize) + 1;
    for (let i = 0; i < maxDrainCycles && this.queue.size > 0; i++) {
      await this.processQueue();
    }
  }

  /** Enqueue a memory for background embedding generation. */
  enqueue(memoryId: string, embeddingText: string, purpose: EmbeddingPurpose = "document", orgId?: string): void {
    if (this.queue.size >= this.maxQueueSize && !this.queue.has(memoryId)) {
      logger.warn("Embedding queue full, dropping oldest item", {
        queue_size: this.queue.size,
        max_size: this.maxQueueSize,
      });
      // Drop oldest item (first entry in Map)
      const firstKey = this.queue.keys().next().value;
      if (firstKey !== undefined) this.queue.delete(firstKey);
    }
    this.queue.set(memoryId, {
      memoryId,
      orgId,
      embeddingText,
      purpose,
      retries: 0,
    });
  }

  /** Current queue size (for monitoring). */
  get size(): number {
    return this.queue.size;
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.size === 0) return;
    this.processing = true;

    try {
      const batch = Array.from(this.queue.values()).slice(0, this.batchSize);
      const provider = getEmbeddingProvider();

      // Track items that failed embedding so we don't delete them from the retry queue
      const failedItems = new Set<string>();

      // Check if provider supports batch embedding
      const texts = batch.map((item) => item.embeddingText);
      const purposes = batch.map((item) => item.purpose);

      // Use batch embed if available and all purposes are the same
      const allSamePurpose = purposes.every((p) => p === purposes[0]);
      let embeddings: (number[] | null)[];

      if (provider.embedBatch && allSamePurpose && batch.length > 1) {
        try {
          const results = await provider.embedBatch(texts, purposes[0]);
          embeddings = results.map((e) => (e.every((v) => v === 0) ? null : e));
        } catch {
          // Fall back to individual embeds
          embeddings = await Promise.all(batch.map((item) => this.embedSingle(item, failedItems)));
        }
      } else {
        embeddings = await Promise.all(batch.map((item) => this.embedSingle(item, failedItems)));
      }

      // Update memories with embeddings
      for (const [i, item] of batch.entries()) {
        const embedding = embeddings[i];
        if (embedding) {
          try {
            await this.memories.update(item.memoryId, { embedding }, item.orgId);
            this.queue.delete(item.memoryId);
            if (this.onEmbeddingReady) {
              await this.onEmbeddingReady(item.memoryId, embedding).catch((err: unknown) => {
                logger.warn("onEmbeddingReady callback failed", {
                  memory_id: item.memoryId,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
            }
          } catch (err: unknown) {
            logger.warn("Failed to update memory with embedding", {
              memory_id: item.memoryId,
              error: err instanceof Error ? err.message : String(err),
            });
            this.handleRetry(item);
          }
        } else if (!failedItems.has(item.memoryId)) {
          // Embedding is null from noop provider or all-zeros — remove from queue
          this.queue.delete(item.memoryId);
        }
        // else: embedding failed, handleRetry already managed the item
      }
    } finally {
      this.processing = false;
    }
  }

  private async embedSingle(item: QueueItem, failedItems: Set<string>): Promise<number[] | null> {
    try {
      const provider = getEmbeddingProvider();
      const result = await provider.embed(item.embeddingText, item.purpose);
      if (result.every((v) => v === 0)) return null;
      return result;
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      const isRetryable = !statusCode || statusCode === 429 || statusCode >= 500;
      logger.warn("Embedding generation failed for queued item", {
        memory_id: item.memoryId,
        error: err instanceof Error ? err.message : String(err),
        retryable: isRetryable,
      });
      failedItems.add(item.memoryId);
      if (isRetryable) {
        this.handleRetry(item);
      } else {
        // Permanent error (auth, bad request) — drop immediately
        logger.warn("Dropping embedding queue item due to permanent error", {
          memory_id: item.memoryId,
          status: statusCode,
        });
        this.queue.delete(item.memoryId);
      }
      return null;
    }
  }

  private handleRetry(item: QueueItem): void {
    item.retries++;
    if (item.retries >= this.maxRetries) {
      logger.warn("Dropping embedding queue item after max retries", {
        memory_id: item.memoryId,
        retries: item.retries,
      });
      this.queue.delete(item.memoryId);
    }
  }
}

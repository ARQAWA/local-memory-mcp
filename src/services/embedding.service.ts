import { createHash } from "node:crypto";
import { LRUCache } from "lru-cache";
import { loadConfig } from "../config.js";
import { logger } from "./logger.js";
import { ExternalServiceError } from "../errors.js";
import { recordEmbeddingSuccess, recordEmbeddingFailure } from "./embedding-metrics.js";

export type EmbeddingPurpose = "document" | "query";

export interface EmbeddingProvider {
  embed(text: string, purpose?: EmbeddingPurpose): Promise<number[]>;
  embedBatch?(texts: string[], purpose?: EmbeddingPurpose): Promise<number[][]>;
  readonly name: string;
}

class NoOpEmbeddingProvider implements EmbeddingProvider {
  readonly name = "noop";
  private dimension: number;

  constructor(dimension: number) {
    this.dimension = dimension;
  }

  embed(_text: string, _purpose?: EmbeddingPurpose): Promise<number[]> {
    return Promise.resolve(new Array<number>(this.dimension).fill(0));
  }
}

class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openrouter";
  private apiKey: string | undefined;
  private baseUrl: string;
  private model: string;
  private dimension: number;

  constructor(apiKey: string | undefined, baseUrl: string, model: string, dimension: number) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
    this.dimension = dimension;
  }

  async embed(text: string, purpose?: EmbeddingPurpose): Promise<number[]> {
    const [embedding] = await this.embedBatch([text], purpose);
    if (!embedding) {
      throw new ExternalServiceError("OpenRouter", "Embedding response was empty");
    }
    return embedding;
  }

  async embedBatch(texts: string[], _purpose?: EmbeddingPurpose): Promise<number[][]> {
    if (!this.apiKey) {
      throw new ExternalServiceError("OpenRouter", "OPENROUTER_API_KEY is not set");
    }

    try {
      const resp = await fetch(`${this.baseUrl.replace(/\/+$/, "")}/embeddings`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          "HTTP-Referer": "http://127.0.0.1",
          "X-Title": "local-memory-mcp",
        },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          dimensions: this.dimension,
        }),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        const err = new ExternalServiceError("OpenRouter", `API error: ${resp.status} ${errText}`);
        (err as ExternalServiceError & { statusCode?: number }).statusCode = resp.status;
        throw err;
      }

      const payload = (await resp.json()) as {
        data?: { embedding?: number[] }[];
      };
      const embeddings =
        payload.data?.map((item) => item.embedding).filter((v): v is number[] => Array.isArray(v)) ?? [];

      if (embeddings.length !== texts.length) {
        throw new ExternalServiceError("OpenRouter", "Unexpected embedding API response format");
      }
      for (const embedding of embeddings) {
        if (embedding.length !== this.dimension) {
          throw new ExternalServiceError(
            "OpenRouter",
            `Expected ${this.dimension} dimensions, got ${embedding.length}`,
          );
        }
        recordEmbeddingSuccess();
      }
      return embeddings;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      for (const _ of texts) recordEmbeddingFailure(message);
      throw err;
    }
  }
}

class CachedEmbeddingProvider implements EmbeddingProvider {
  private inner: EmbeddingProvider;
  private cache: LRUCache<string, number[]>;
  private hits = 0;
  private misses = 0;

  get name() {
    return this.inner.name;
  }

  constructor(inner: EmbeddingProvider, maxSize = 1000, ttlMs = 3_600_000) {
    this.inner = inner;
    this.cache = new LRUCache<string, number[]>({
      max: maxSize,
      ttl: ttlMs,
    });
  }

  private cacheKey(text: string, purpose?: EmbeddingPurpose): string {
    return createHash("sha256")
      .update(this.inner.name)
      .update("|")
      .update(purpose ?? "document")
      .update("|")
      .update(text)
      .digest("hex");
  }

  async embed(text: string, purpose?: EmbeddingPurpose): Promise<number[]> {
    const key = this.cacheKey(text, purpose);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }

    this.misses++;
    const embedding = await this.inner.embed(text, purpose);
    this.cache.set(key, embedding);
    return embedding;
  }

  async embedBatch(texts: string[], purpose?: EmbeddingPurpose): Promise<number[][]> {
    const results: (number[] | null)[] = texts.map(() => null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    for (const [i, text] of texts.entries()) {
      const key = this.cacheKey(text, purpose);
      const cached = this.cache.get(key);
      if (cached !== undefined) {
        this.hits++;
        results[i] = cached;
      } else {
        this.misses++;
        uncachedIndices.push(i);
        uncachedTexts.push(text);
      }
    }

    if (uncachedTexts.length > 0) {
      const innerBatch = this.inner.embedBatch
        ? await this.inner.embedBatch(uncachedTexts, purpose)
        : await Promise.all(uncachedTexts.map((text) => this.inner.embed(text, purpose)));

      for (const [j, idx] of uncachedIndices.entries()) {
        const embedding = innerBatch[j];
        const text = texts[idx];
        if (!embedding || !text) continue;
        results[idx] = embedding;
        this.cache.set(this.cacheKey(text, purpose), embedding);
      }
    }

    for (let i = 0; i < results.length; i++) {
      if (!results[i]) {
        throw new ExternalServiceError("Embedding", `embedBatch: missing embedding for text at index ${i}`);
      }
    }
    return results as number[][];
  }

  get stats(): EmbeddingCacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.cache.size,
      maxSize: this.cache.max,
      hitRate: this.hits + this.misses > 0 ? this.hits / (this.hits + this.misses) : 0,
    };
  }
}

export interface EmbeddingCacheStats {
  hits: number;
  misses: number;
  size: number;
  maxSize: number;
  hitRate: number;
}

let provider: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (provider) return provider;

  const config = loadConfig();
  if (config.embeddingProvider === "noop") {
    provider = new NoOpEmbeddingProvider(config.embeddingDimension);
    logger.info("Using noop embedding provider", { dimension: config.embeddingDimension });
    return provider;
  }

  const raw = new OpenRouterEmbeddingProvider(
    config.openRouterApiKey,
    config.openRouterBaseUrl,
    config.embeddingModel,
    config.embeddingDimension,
  );
  provider = new CachedEmbeddingProvider(raw);
  logger.info("Using OpenRouter embedding provider", {
    model: config.embeddingModel,
    dimension: config.embeddingDimension,
  });
  return provider;
}

export function getEmbeddingCacheStats(): EmbeddingCacheStats | null {
  if (provider instanceof CachedEmbeddingProvider) return provider.stats;
  return null;
}

export function resetEmbeddingProvider(): void {
  provider = null;
}

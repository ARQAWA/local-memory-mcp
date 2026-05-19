import { z } from "zod";

export const DEFAULT_DATABASE_URL = "postgres://local_memory:local_memory@127.0.0.1:55432/local_memory";

export const configSchema = z
  .object({
    port: z.coerce.number().int().min(1).max(65535).default(13765),
    host: z.string().default("127.0.0.1"),
    nodeEnv: z.enum(["development", "production", "test"]).default("development"),

    databaseUrl: z.string().default(DEFAULT_DATABASE_URL),

    embeddingProvider: z.enum(["openrouter", "noop"]).default("openrouter"),
    embeddingModel: z.string().default("openai/text-embedding-3-small"),
    embeddingDimension: z.coerce.number().int().min(1).max(4096).default(256),
    openRouterApiKey: z.string().optional(),
    openRouterBaseUrl: z.url().default("https://openrouter.ai/api/v1"),
    asyncEmbedding: z.coerce.boolean().default(false),

    rateLimitPerMin: z.coerce.number().int().min(1).max(100_000).default(500),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const env = process.env;
  cached = configSchema.parse({
    port: env["LOCAL_MEMORY_PORT"] ?? env["PORT"],
    host: env["LOCAL_MEMORY_HOST"] ?? env["HOST"],
    nodeEnv: env["NODE_ENV"],
    databaseUrl: env["LOCAL_MEMORY_DATABASE_URL"] ?? env["DATABASE_URL"],
    embeddingProvider: env["EMBEDDING_PROVIDER"],
    embeddingModel: env["EMBEDDING_MODEL"],
    embeddingDimension: env["EMBEDDING_DIMENSION"],
    openRouterApiKey: env["OPENROUTER_API_KEY"],
    openRouterBaseUrl: env["OPENROUTER_BASE_URL"],
    asyncEmbedding: env["ASYNC_EMBEDDING"],
    rateLimitPerMin: env["RATE_LIMIT_PER_MIN"],
  });
  return cached;
}

export function resetConfig(): void {
  cached = null;
}

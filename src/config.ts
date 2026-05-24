import { z } from "zod";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_DATABASE_PATH = join(homedir(), ".local", "share", "local-memory-mcp", "local-memory.sqlite3");

export const configSchema = z
  .object({
    nodeEnv: z.enum(["development", "production", "test"]).default("development"),

    databasePath: z.string().min(1).default(DEFAULT_DATABASE_PATH),
    sqliteExtensionPath: z.string().min(1).optional(),

    embeddingProvider: z.enum(["openrouter", "noop"]).default("openrouter"),
    embeddingModel: z.string().default("openai/text-embedding-3-small"),
    embeddingDimension: z.coerce.number().int().min(1).max(4096).default(256),
    openRouterApiKey: z.string().optional(),
    openRouterBaseUrl: z.url().default("https://openrouter.ai/api/v1"),
    asyncEmbedding: z.coerce.boolean().default(false),
  })
  .strict();

export type Config = z.infer<typeof configSchema>;

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const env = process.env;
  cached = configSchema.parse({
    nodeEnv: env["NODE_ENV"],
    databasePath: env["LOCAL_MEMORY_DB_PATH"],
    sqliteExtensionPath: env["LOCAL_MEMORY_SQLITE_EXTENSION_PATH"],
    embeddingProvider: env["EMBEDDING_PROVIDER"],
    embeddingModel: env["EMBEDDING_MODEL"],
    embeddingDimension: env["EMBEDDING_DIMENSION"],
    openRouterApiKey: env["OPENROUTER_API_KEY"],
    openRouterBaseUrl: env["OPENROUTER_BASE_URL"],
    asyncEmbedding: env["ASYNC_EMBEDDING"],
  });
  return cached;
}

export function resetConfig(): void {
  cached = null;
}

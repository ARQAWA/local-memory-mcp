#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { MemoryService } from "./services/memory.service.js";
import { EmbeddingQueue } from "./services/embedding-queue.js";
import { logger } from "./services/logger.js";
import { runMigrations } from "./db/migrate.js";
import { closeDb } from "./db/connection.js";
import { samplingContext } from "./context.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let APP_VERSION = "0.1.0";
try {
  APP_VERSION = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")).version;
} catch {
  // Keep fallback version.
}

process.on("uncaughtException", (err) => {
  logger.error("Uncaught exception", { error: err.message, stack: err.stack });
  process.exit(1);
});

process.on("unhandledRejection", (reason: unknown) => {
  const message = reason instanceof Error ? reason.message : String(reason);
  const stack = reason instanceof Error ? reason.stack : undefined;
  logger.error("Unhandled rejection", { error: message, stack });
});

async function createMemoryService(config = loadConfig()): Promise<{
  service: MemoryService;
  embeddingQueue: EmbeddingQueue | undefined;
}> {
  await runMigrations();

  let embeddingQueue: EmbeddingQueue | undefined;
  if (config.asyncEmbedding) {
    const { MemoryRepository } = await import("./repositories/memory.repository.js");
    embeddingQueue = new EmbeddingQueue(new MemoryRepository());
    embeddingQueue.start();
    logger.info("Async embedding queue enabled");
  }

  const service = new MemoryService({
    embeddingQueue,
    asyncEmbedding: config.asyncEmbedding,
  });

  return { service, embeddingQueue };
}

async function startStdio(): Promise<void> {
  const config = loadConfig();
  const { service, embeddingQueue } = await createMemoryService(config);
  const { mcpServer, samplingService } = createMcpServer(service, APP_VERSION);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received. Shutting down...`);
    setTimeout(() => {
      logger.error("Forced shutdown after timeout.");
      process.exit(1);
    }, 10_000).unref();

    try {
      await service.flushSync();
      if (embeddingQueue) await embeddingQueue.stop();
      await transport.close();
      await closeDb();
    } catch (err: unknown) {
      logger.warn("Shutdown failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    process.exit(0);
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  samplingContext.enterWith(samplingService);
  await mcpServer.connect(transport);
  logger.info("local-memory-mcp running on stdio");
}

startStdio().catch((err: unknown) => {
  logger.error("Failed to start MCP server", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { logger } from "./services/logger.js";
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

async function startStdio(): Promise<void> {
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { MemorydProxyClient } = await import("./memoryd/client.js");
  const { createMcpServer } = await import("./server.js");
  const service = new MemorydProxyClient();
  const { mcpServer, samplingService } = createMcpServer(service, APP_VERSION);
  const transport = new StdioServerTransport();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`${signal} received. Shutting down...`);
    setTimeout(() => {
      logger.error("Forced shutdown after timeout.");
      process.exit(1);
    }, 10_000).unref();

    try {
      await transport.close();
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

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("memoryd")) {
    const { startMemorydServer } = await import("./memoryd/server.js");
    await startMemorydServer();
    return;
  }
  await startStdio();
}

main().catch((err: unknown) => {
  logger.error("Failed to start local-memory-mcp", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

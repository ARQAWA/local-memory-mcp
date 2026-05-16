#!/usr/bin/env node
import express from "express";
import helmet from "helmet";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { MemoryService } from "./services/memory.service.js";
import { EmbeddingQueue } from "./services/embedding-queue.js";
import { logger } from "./services/logger.js";
import { runMigrations } from "./db/migrate.js";
import { closeDb } from "./db/connection.js";
import { requestContext, samplingContext } from "./context.js";
import { registerApiRoutes } from "./api/routes.js";
import { registerAdminRoutes } from "./api/admin-routes.js";
import { toOrgId, toTeamSlug, toUserId } from "./types/index.js";

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

function modeFromArgs(): "stdio" | "web" {
  if (process.argv.includes("--web") || process.argv.includes("web")) return "web";
  return "stdio";
}

function publicDir(): string {
  const distPublic = join(__dirname, "public");
  if (existsSync(distPublic)) return distPublic;
  return join(__dirname, "..", "public");
}

function assertLocalHost(host: string): void {
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
    throw new Error(`Web/Admin UI must bind only to localhost. Refusing HOST=${host}`);
  }
}

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

  const shutdown = async (signal: string) => {
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

async function startWeb(): Promise<void> {
  const config = loadConfig();
  assertLocalHost(config.host);
  const { service, embeddingQueue } = await createMemoryService(config);

  const app = express();
  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
        },
      },
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  const rateLimiter = createRateLimiter(config.rateLimitPerMin);
  app.use("/api", rateLimiter);
  app.use("/admin/api", rateLimiter);

  app.use((req, _res, next) => {
    const org = readHeader(req.headers["x-engram-org"]) ?? "local";
    const team = readHeader(req.headers["x-engram-team"]);
    const user = readHeader(req.headers["x-engram-user"]) ?? "local-admin";
    requestContext.run(
      {
        org_id: toOrgId(org),
        team_slug: team ? toTeamSlug(team) : undefined,
        user_id: toUserId(user),
        role: "admin",
      },
      next,
    );
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, mode: "local", version: APP_VERSION });
  });

  app.post("/api/token/generate", (_req, res) => {
    res.json({ token: "local.local.local", local_only: true });
  });

  registerApiRoutes(app, service);
  registerAdminRoutes(app, service);

  const dir = publicDir();
  app.use("/ui", express.static(dir));
  app.get("/", (_req, res) => res.redirect("/ui"));
  app.get("/ui", (_req, res) => res.sendFile(join(dir, "index.html")));

  const server = app.listen(config.port, config.host, () => {
    logger.info(`local-memory-web listening on http://${config.host}:${config.port}`, {
      ui: `http://${config.host}:${config.port}/ui`,
      admin: `http://${config.host}:${config.port}/admin`,
    });
  });

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received. Shutting down web server...`);
    server.close(async () => {
      try {
        if (embeddingQueue) await embeddingQueue.stop();
        await closeDb();
      } finally {
        process.exit(0);
      }
    });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function createRateLimiter(limitPerMin: number): express.RequestHandler {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const windowMs = 60_000;
  return (req, res, next) => {
    const key = req.ip ?? "local";
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || now > bucket.resetAt) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count++;
    if (bucket.count > limitPerMin) {
      res.status(429).json({ error: "Rate limit exceeded" });
      return;
    }
    next();
  };
}

const mode = modeFromArgs();
if (mode === "web") {
  startWeb().catch((err: unknown) => {
    logger.error("Failed to start web server", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
} else {
  startStdio().catch((err: unknown) => {
    logger.error("Failed to start MCP server", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  });
}

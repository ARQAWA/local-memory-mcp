import { createServer, type Server, type Socket } from "node:net";
import { rmSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { requestContext } from "../context.js";
import { closeDb } from "../db/connection.js";
import { runMigrations } from "../db/migrate.js";
import { LocalMemoryError } from "../errors.js";
import { MemoryService } from "../services/memory.service.js";
import { EmbeddingQueue } from "../services/embedding-queue.js";
import { logger } from "../services/logger.js";
import { LlamaCppRerankerService } from "../services/reranker.service.js";
import type { CommitTaskInput, CorrectMemoryInput, PrepareContextInput } from "../tools/project-memory-backend.js";
import type { MemorydRequest, MemorydResponse, MemorydStatus } from "./protocol.js";
import { appendMemorydLog, ensureMemorydStateDir, getMemorydPaths } from "./paths.js";

interface MemorydRuntime {
  service: MemoryService;
  embeddingQueue: EmbeddingQueue | undefined;
  reranker: LlamaCppRerankerService;
  startedAt: number;
}

function messageText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseRequest(line: string): MemorydRequest {
  const parsed: unknown = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("request must be an object");
  const record = parsed as Record<string, unknown>;
  const id = record["id"];
  const method = record["method"];
  if (typeof id !== "string" || typeof method !== "string") throw new Error("request id and method are required");
  if (
    method !== "prepare_context" &&
    method !== "commit_task" &&
    method !== "correct_memory" &&
    method !== "health" &&
    method !== "doctor/status"
  ) {
    throw new Error(`unknown memoryd method: ${method}`);
  }
  return {
    id,
    method,
    params: record["params"],
    context: record["context"] as MemorydRequest["context"],
  };
}

function serializeError(id: string, err: unknown): MemorydResponse {
  const detail =
    err instanceof LocalMemoryError &&
    "originalError" in err &&
    err.originalError instanceof Error &&
    err.originalError.message
      ? err.originalError.message
      : undefined;
  if (err instanceof LocalMemoryError) {
    return {
      id,
      ok: false,
      error: {
        message: err.message,
        code: err.code,
        statusCode: err.statusCode,
        detail,
      },
    };
  }
  return {
    id,
    ok: false,
    error: {
      message: messageText(err),
    },
  };
}

async function createRuntime(): Promise<MemorydRuntime> {
  const config = loadConfig();
  await runMigrations();
  const reranker = new LlamaCppRerankerService();
  await reranker.start();

  let embeddingQueue: EmbeddingQueue | undefined;
  if (config.asyncEmbedding) {
    const { MemoryRepository } = await import("../repositories/memory.repository.js");
    embeddingQueue = new EmbeddingQueue(new MemoryRepository());
    embeddingQueue.start();
    logger.info("Async embedding queue enabled");
  }

  const service = new MemoryService({
    embeddingQueue,
    asyncEmbedding: config.asyncEmbedding,
    reranker,
  });

  return { service, embeddingQueue, reranker, startedAt: Date.now() };
}

function status(runtime: MemorydRuntime): MemorydStatus {
  const paths = getMemorydPaths();
  const rerankerStatus = runtime.reranker.status();
  return {
    ok: true,
    pid: process.pid,
    socket_path: paths.socketPath,
    pid_path: paths.pidPath,
    lock_path: paths.lockPath,
    log_path: paths.logPath,
    database_path: loadConfig().databasePath,
    app_root: runtime.reranker.appRoot,
    uptime_seconds: Math.max(0, Math.round((Date.now() - runtime.startedAt) / 1000)),
    reranker_backend: rerankerStatus.backend,
    qwen_ready: rerankerStatus.ready,
    qwen_runtime_pid: rerankerStatus.runtime_pid,
    qwen_model_path: rerankerStatus.model_path,
    llama_server_path: rerankerStatus.llama_server_path,
    reranker_endpoint: rerankerStatus.endpoint,
    reranker_idle_timeout_ms: rerankerStatus.idle_timeout_ms,
    reranker_last_used_at: rerankerStatus.last_used_at,
  };
}

async function dispatch(runtime: MemorydRuntime, request: MemorydRequest): Promise<unknown> {
  const execute = async (): Promise<unknown> => {
    if (request.method === "health" || request.method === "doctor/status") return status(runtime);
    if (request.method === "prepare_context")
      return runtime.service.prepareContext(request.params as PrepareContextInput);
    if (request.method === "commit_task") return runtime.service.commitTask(request.params as CommitTaskInput);
    return runtime.service.correctMemory(request.params as CorrectMemoryInput);
  };
  if (request.context) return requestContext.run(request.context, execute);
  return execute();
}

async function handleLine(runtime: MemorydRuntime, socket: Socket, line: string): Promise<void> {
  let requestId = "unknown";
  try {
    const request = parseRequest(line);
    requestId = request.id;
    const result = await dispatch(runtime, request);
    socket.write(`${JSON.stringify({ id: request.id, ok: true, result } satisfies MemorydResponse)}\n`);
  } catch (err: unknown) {
    appendMemorydLog("error", { action: "handle request", error: messageText(err) });
    socket.write(`${JSON.stringify(serializeError(requestId, err))}\n`);
  }
}

function listen(server: Server, socketPath: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(socketPath, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}

export async function startMemorydServer(): Promise<void> {
  const paths = getMemorydPaths();
  ensureMemorydStateDir(paths);
  writeFileSync(paths.pidPath, `${process.pid}\n`);
  appendMemorydLog("started", { pid: process.pid, phase: "booting" }, paths);

  let runtime: MemorydRuntime | null = null;
  let server: Server | null = null;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    appendMemorydLog("stopped", { pid: process.pid, signal }, paths);
    try {
      if (server) await closeServer(server);
      if (runtime) {
        await runtime.service.flushSync();
        if (runtime.embeddingQueue) await runtime.embeddingQueue.stop();
      }
      await closeDb();
    } catch (err: unknown) {
      appendMemorydLog("error", { action: "shutdown", error: messageText(err) }, paths);
    } finally {
      rmSync(paths.socketPath, { force: true });
      rmSync(paths.pidPath, { force: true });
      process.exit(0);
    }
  };

  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGHUP", () => {
    void shutdown("SIGHUP");
  });

  try {
    rmSync(paths.socketPath, { force: true });
    runtime = await createRuntime();
    const activeRuntime = runtime;
    server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        let newlineIndex = buffer.indexOf("\n");
        while (newlineIndex >= 0) {
          const line = buffer.slice(0, newlineIndex).trim();
          buffer = buffer.slice(newlineIndex + 1);
          if (line) void handleLine(activeRuntime, socket, line);
          newlineIndex = buffer.indexOf("\n");
        }
      });
    });
    await listen(server, paths.socketPath);
    appendMemorydLog("started", { ...status(runtime) }, paths);
    logger.info("local-memory memoryd running", {
      pid: process.pid,
      socket: paths.socketPath,
      qwen_runtime_pid: runtime.reranker.status().runtime_pid,
    });
  } catch (err: unknown) {
    appendMemorydLog("error", { action: "start memoryd", error: messageText(err) }, paths);
    rmSync(paths.socketPath, { force: true });
    rmSync(paths.pidPath, { force: true });
    throw err;
  }
}

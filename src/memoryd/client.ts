import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, rmSync, statSync, writeFileSync, type PathLike } from "node:fs";
import { createConnection } from "node:net";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getRequestContextOrDefault } from "../context.js";
import { LocalMemoryError } from "../errors.js";
import type {
  CommitTaskInput,
  CommitTaskOutput,
  CorrectMemoryInput,
  CorrectMemoryResult,
  PrepareContextInput,
  PrepareContextOutput,
  ProjectMemoryBackend,
} from "../tools/project-memory-backend.js";
import { appendMemorydLog, ensureMemorydStateDir, getMemorydPaths, type MemorydPaths } from "./paths.js";
import type { MemorydErrorPayload, MemorydMethod, MemorydRequest, MemorydResponse, MemorydStatus } from "./protocol.js";

const STARTUP_TIMEOUT_MS = 180_000;
const REQUEST_TIMEOUT_MS = 180_000;
const LOCK_TIMEOUT_MS = 190_000;
const LOCK_STALE_MS = 120_000;

export class MemorydRemoteError extends LocalMemoryError {
  constructor(error: MemorydErrorPayload) {
    super(error.message, error.code ?? "MEMORYD_ERROR", error.statusCode ?? 500);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function messageText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readPid(pidPath: string): number | null {
  try {
    const pid = Number(readFileSync(pidPath, "utf-8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

function removePath(path: PathLike): void {
  rmSync(path, { force: true });
}

async function waitForExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return;
    await sleep(100);
  }
}

async function cleanupStaleMemoryd(paths: MemorydPaths, reason: string): Promise<void> {
  const pid = readPid(paths.pidPath);
  appendMemorydLog("stale cleanup", { reason, pid }, paths);
  if (pid && isProcessAlive(pid)) {
    try {
      process.kill(pid, "SIGTERM");
      await waitForExit(pid, 3_000);
    } catch (err: unknown) {
      appendMemorydLog("error", { action: "kill stale memoryd", error: messageText(err), pid }, paths);
    }
  }
  removePath(paths.socketPath);
  removePath(paths.pidPath);
}

async function acquireStartupLock(paths: MemorydPaths): Promise<() => void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(paths.lockPath, "wx");
      writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
      return () => {
        closeSync(fd);
        removePath(paths.lockPath);
      };
    } catch (err: unknown) {
      if (!(err instanceof Error) || !("code" in err) || err.code !== "EEXIST") throw err;
      try {
        const ageMs = Date.now() - statSync(paths.lockPath).mtimeMs;
        if (ageMs > LOCK_STALE_MS) {
          appendMemorydLog("stale cleanup", { reason: "startup lock stale", age_ms: Math.round(ageMs) }, paths);
          removePath(paths.lockPath);
          continue;
        }
      } catch {
        removePath(paths.lockPath);
        continue;
      }
      await sleep(200);
    }
  }
  throw new Error(`Timed out waiting for memoryd startup lock: ${paths.lockPath}`);
}

function parseResponse(line: string): MemorydResponse {
  const parsed: unknown = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== "object") throw new Error("memoryd returned non-object response");
  const record = parsed as Record<string, unknown>;
  if (typeof record["id"] !== "string" || typeof record["ok"] !== "boolean") {
    throw new Error("memoryd returned invalid response envelope");
  }
  if (record["ok"]) {
    return { id: record["id"], ok: true, result: record["result"] };
  }
  const error = record["error"];
  if (!error || typeof error !== "object") throw new Error("memoryd returned invalid error response");
  const errorRecord = error as Record<string, unknown>;
  const message = errorRecord["message"];
  if (typeof message !== "string") throw new Error("memoryd returned error without message");
  return {
    id: record["id"],
    ok: false,
    error: {
      message,
      code: typeof errorRecord["code"] === "string" ? errorRecord["code"] : undefined,
      statusCode: typeof errorRecord["statusCode"] === "number" ? errorRecord["statusCode"] : undefined,
      detail: typeof errorRecord["detail"] === "string" ? errorRecord["detail"] : undefined,
    },
  };
}

async function rawRequest(
  method: MemorydMethod,
  params?: unknown,
  context?: MemorydRequest["context"],
  paths = getMemorydPaths(),
): Promise<unknown> {
  const request: MemorydRequest = {
    id: randomUUID(),
    method,
    params,
    context,
  };

  return new Promise<unknown>((resolveRequest, rejectRequest) => {
    const socket = createConnection(paths.socketPath);
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error(`memoryd request timed out after ${REQUEST_TIMEOUT_MS} ms`));
    }, REQUEST_TIMEOUT_MS);

    const finish = (err: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) {
        rejectRequest(err);
        return;
      }
      resolveRequest(value);
    };

    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      try {
        const response = parseResponse(line);
        if (response.id !== request.id) throw new Error("memoryd response id mismatch");
        if (!response.ok) throw new MemorydRemoteError(response.error);
        finish(null, response.result);
      } catch (err: unknown) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
    socket.on("error", (err) => {
      finish(err);
    });
    socket.on("close", () => {
      if (!settled) finish(new Error("memoryd socket closed before response"));
    });
  });
}

async function probeHealth(paths: MemorydPaths): Promise<MemorydStatus | null> {
  try {
    const result = await rawRequest("health", undefined, undefined, paths);
    return result as MemorydStatus;
  } catch {
    return null;
  }
}

function memorydSpawnCommand(): { command: string; args: string[]; cwd: string } {
  const here = fileURLToPath(import.meta.url);
  const ext = extname(here);
  const root = resolve(dirname(here), "..", "..");
  const indexPath = resolve(dirname(here), "..", `index${ext}`);
  if (ext === ".ts") {
    return { command: "pnpm", args: ["exec", "tsx", indexPath, "memoryd"], cwd: root };
  }
  return { command: process.execPath, args: [indexPath, "memoryd"], cwd: root };
}

async function waitForHealth(paths: MemorydPaths): Promise<MemorydStatus> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    const status = await probeHealth(paths);
    if (status) return status;
    const pid = readPid(paths.pidPath);
    if (pid && !isProcessAlive(pid)) lastError = `memoryd pid ${pid} exited`;
    await sleep(500);
  }
  throw new Error(`memoryd did not become healthy: ${lastError}`);
}

async function startMemoryd(paths: MemorydPaths): Promise<MemorydStatus> {
  const { command, args, cwd } = memorydSpawnCommand();
  const logFd = openSync(paths.logPath, "a");
  try {
    const child = spawn(command, args, {
      cwd,
      detached: true,
      env: { ...process.env, LOCAL_MEMORY_APP_ROOT: cwd, LOCAL_MEMORY_STATE_DIR: paths.stateDir },
      stdio: ["ignore", logFd, logFd],
    });
    child.unref();
    appendMemorydLog("started", { launcher_pid: process.pid, memoryd_pid: child.pid ?? null, command, args }, paths);
  } finally {
    closeSync(logFd);
  }
  return waitForHealth(paths);
}

export async function ensureMemorydRunning(paths = getMemorydPaths()): Promise<MemorydStatus> {
  ensureMemorydStateDir(paths);
  const existing = await probeHealth(paths);
  if (existing) {
    appendMemorydLog("reused", { pid: existing.pid, qwen_runtime_pid: existing.qwen_runtime_pid }, paths);
    return existing;
  }

  const release = await acquireStartupLock(paths);
  try {
    const afterLock = await probeHealth(paths);
    if (afterLock) {
      appendMemorydLog("reused", { pid: afterLock.pid, qwen_runtime_pid: afterLock.qwen_runtime_pid }, paths);
      return afterLock;
    }

    const pid = readPid(paths.pidPath);
    if (pid) {
      if (isProcessAlive(pid)) {
        await cleanupStaleMemoryd(paths, "socket dead while pid alive");
      } else {
        await cleanupStaleMemoryd(paths, "pid stale");
      }
    } else if (existsSync(paths.socketPath)) {
      await cleanupStaleMemoryd(paths, "socket stale");
    }

    return await startMemoryd(paths);
  } catch (err: unknown) {
    appendMemorydLog("error", { action: "ensure memoryd", error: messageText(err) }, paths);
    throw err;
  } finally {
    release();
  }
}

export async function requestMemoryd(
  method: MemorydMethod,
  params?: unknown,
  context?: MemorydRequest["context"],
): Promise<unknown> {
  const paths = getMemorydPaths();
  await ensureMemorydRunning(paths);
  try {
    return await rawRequest(method, params, context, paths);
  } catch (err: unknown) {
    if (err instanceof MemorydRemoteError) throw err;
    await cleanupStaleMemoryd(paths, `request failed: ${messageText(err)}`);
    await ensureMemorydRunning(paths);
    return rawRequest(method, params, context, paths);
  }
}

export class MemorydProxyClient implements ProjectMemoryBackend {
  async prepareContext(input: PrepareContextInput): Promise<PrepareContextOutput> {
    const result = await requestMemoryd("prepare_context", input, getRequestContextOrDefault());
    return result as PrepareContextOutput;
  }

  async commitTask(input: CommitTaskInput): Promise<CommitTaskOutput> {
    const result = await requestMemoryd("commit_task", input, getRequestContextOrDefault());
    return result as CommitTaskOutput;
  }

  async correctMemory(input: CorrectMemoryInput): Promise<CorrectMemoryResult | null> {
    const result = await requestMemoryd("correct_memory", input, getRequestContextOrDefault());
    return result as CorrectMemoryResult | null;
  }

  async health(): Promise<MemorydStatus> {
    const result = await requestMemoryd("health");
    return result as MemorydStatus;
  }

  async doctorStatus(): Promise<MemorydStatus> {
    const result = await requestMemoryd("doctor/status");
    return result as MemorydStatus;
  }
}

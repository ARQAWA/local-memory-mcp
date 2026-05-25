import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ExternalServiceError } from "../errors.js";

export interface RerankCandidateInput {
  id: string;
  text: string;
}

export interface RerankResult {
  id: string;
  score: number;
}

export interface Reranker {
  start(): Promise<void>;
  rerank(query: string, candidates: RerankCandidateInput[]): Promise<RerankResult[]>;
  healthCheck(): Promise<RerankResult[]>;
  close(): Promise<void>;
}

export interface RerankerStatus {
  backend: string;
  ready: boolean;
  runtime_pid: number | null;
  model_path: string;
  llama_server_path: string;
  endpoint: string | null;
  idle_timeout_ms: number;
  last_used_at: string | null;
}

interface LlamaCppRerankerOptions {
  appRoot?: string | undefined;
  llamaServerPath?: string | undefined;
  modelPath?: string | undefined;
  host?: string | undefined;
  port?: number | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  idleTimeoutMs?: number | undefined;
}

interface RerankerProfile {
  llama_server_path?: unknown;
  model_path?: unknown;
  idle_timeout_ms?: unknown;
}

interface RerankApiRecord {
  index: number;
  score: number;
}

export const RERANKER_BACKEND = "qwen3-gguf-llama.cpp";
export const QWEN_RERANKER_MODEL_REPO = "QuantFactory/Qwen3-Reranker-0.6B-GGUF";
export const QWEN_RERANKER_MODEL_FILE = "Qwen3-Reranker-0.6B.Q4_K_M.gguf";
export const RERANKER_OPERATIONAL_ERROR = "memory is not operational without Qwen3 GGUF reranker";
export const DEFAULT_RERANKER_MODEL_PATH = join(
  homedir(),
  ".local",
  "share",
  "local-memory-mcp",
  "models",
  "qwen3-reranker-0.6b-gguf",
  QWEN_RERANKER_MODEL_FILE,
);
export const DEFAULT_RERANKER_PROFILE_PATH = join(
  homedir(),
  ".local",
  "share",
  "local-memory-mcp",
  "reranker-profile.json",
);

function appRootFromImport(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..");
}

function positiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return undefined;
  return value;
}

function operationalError(message: string): ExternalServiceError {
  return new ExternalServiceError("Qwen3 GGUF reranker via llama.cpp", `${RERANKER_OPERATIONAL_ERROR}: ${message}`);
}

function messageText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function loadProfile(): RerankerProfile {
  if (!existsSync(DEFAULT_RERANKER_PROFILE_PATH)) return {};
  try {
    const parsed = JSON.parse(readFileSync(DEFAULT_RERANKER_PROFILE_PATH, "utf-8")) as unknown;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err: unknown) {
    throw operationalError(`reranker profile is invalid at ${DEFAULT_RERANKER_PROFILE_PATH}: ${messageText(err)}`);
  }
}

function profileString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function findLlamaServerPath(profile: RerankerProfile, explicit?: string): string {
  return (
    explicit ??
    process.env["LOCAL_MEMORY_LLAMA_SERVER_BIN"] ??
    process.env["LOCAL_MEMORY_LLAMA_SERVER_PATH"] ??
    profileString(profile.llama_server_path) ??
    "/opt/homebrew/bin/llama-server"
  );
}

function verifyGguf(path: string): void {
  if (!existsSync(path)) {
    throw operationalError(`model file not found at ${path}; run pnpm run setup:reranker`);
  }
  const header = readFileSync(path).subarray(0, 4).toString("utf-8");
  if (header !== "GGUF") {
    throw operationalError(`model file is not a GGUF file: ${path}; run pnpm run setup:reranker`);
  }
}

function isProcessRunning(child: ChildProcessWithoutNullStreams | null): boolean {
  return !!child && child.exitCode === null && child.signalCode === null;
}

async function findOpenPort(host: string): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, host, () => {
      const address = server.address();
      server.close();
      if (!address || typeof address === "string") {
        rejectPort(new Error("could not allocate a TCP port"));
        return;
      }
      resolvePort(address.port);
    });
  });
}

function parseNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseIndex(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parseRecord(value: unknown): RerankApiRecord | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const index = parseIndex(record["index"] ?? record["document_index"]);
  const score = parseNumber(record["relevance_score"] ?? record["score"] ?? record["logit"]);
  if (index === null || score === null) return null;
  return { index, score };
}

function parseRerankApiResponse(value: unknown, candidates: RerankCandidateInput[]): RerankResult[] {
  let records: RerankApiRecord[] = [];
  if (Array.isArray(value)) {
    records = value.map(parseRecord).filter((item): item is RerankApiRecord => item !== null);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const ranked = record["results"] ?? record["data"] ?? record["ranking"];
    if (Array.isArray(ranked)) {
      records = ranked.map(parseRecord).filter((item): item is RerankApiRecord => item !== null);
    } else if (Array.isArray(record["scores"])) {
      records = record["scores"]
        .map((score, index): RerankApiRecord | null => {
          const parsed = parseNumber(score);
          return parsed === null ? null : { index, score: parsed };
        })
        .filter((item): item is RerankApiRecord => item !== null);
    }
  }

  const result = records
    .filter((record) => record.index < candidates.length)
    .map((record) => ({ id: candidates[record.index]?.id ?? "", score: record.score }))
    .filter((item) => item.id.length > 0)
    .sort((a, b) => b.score - a.score);
  if (result.length === 0 && candidates.length > 0) {
    throw operationalError("llama-server returned no rerank scores");
  }
  return result;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body: unknown = text;
    if (text.trim().length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { status: response.status, body };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      throw operationalError(`llama-server request timed out after ${timeoutMs} ms`);
    }
    throw operationalError(`llama-server request failed: ${messageText(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

export class LlamaCppRerankerService implements Reranker {
  readonly appRoot: string;
  readonly llamaServerPath: string;
  readonly modelPath: string;
  readonly host: string;
  readonly configuredPort: number | undefined;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly idleTimeoutMs: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private ready = false;
  private endpoint: string | null = null;
  private stderrBuffer = "";
  private stdoutBuffer = "";
  private closing = false;
  private idleTimer: NodeJS.Timeout | null = null;
  private activeRequests = 0;
  private lastUsedAt = 0;
  private lastRuntimeError: Error | null = null;

  constructor(options?: LlamaCppRerankerOptions) {
    const profile = loadProfile();
    this.appRoot = options?.appRoot ?? process.env["LOCAL_MEMORY_APP_ROOT"] ?? appRootFromImport();
    this.llamaServerPath = findLlamaServerPath(profile, options?.llamaServerPath);
    this.modelPath =
      options?.modelPath ??
      process.env["LOCAL_MEMORY_RERANKER_MODEL_PATH"] ??
      profileString(profile.model_path) ??
      DEFAULT_RERANKER_MODEL_PATH;
    this.host = options?.host ?? process.env["LOCAL_MEMORY_RERANKER_HOST"] ?? "127.0.0.1";
    this.configuredPort =
      options?.port ?? optionalPositiveInt(Number(process.env["LOCAL_MEMORY_RERANKER_PORT"]) || undefined);
    this.startupTimeoutMs =
      options?.startupTimeoutMs ?? positiveInt(process.env["LOCAL_MEMORY_RERANKER_STARTUP_TIMEOUT_MS"], 120_000);
    this.requestTimeoutMs =
      options?.requestTimeoutMs ?? positiveInt(process.env["LOCAL_MEMORY_RERANKER_TIMEOUT_MS"], 60_000);
    this.idleTimeoutMs =
      options?.idleTimeoutMs ??
      positiveInt(
        process.env["LOCAL_MEMORY_RERANKER_IDLE_TIMEOUT_MS"],
        optionalPositiveInt(profile.idle_timeout_ms) ?? 600_000,
      );
  }

  async start(): Promise<void> {
    if (this.ready && isProcessRunning(this.child)) {
      this.armIdleTimer();
      return;
    }
    if (this.startPromise) return this.startPromise;
    this.assertReadyToSpawn();
    this.startPromise = this.spawnServer();
    return this.startPromise;
  }

  async rerank(query: string, candidates: RerankCandidateInput[]): Promise<RerankResult[]> {
    if (candidates.length === 0) return [];
    await this.start();
    return this.rerankWithRunningServer(query, candidates);
  }

  async healthCheck(): Promise<RerankResult[]> {
    return this.rerank("local memory reranker readiness", [
      { id: "relevant", text: "Local Memory MCP uses Qwen3 GGUF reranking through llama.cpp." },
      { id: "irrelevant", text: "This passage talks about unrelated weather." },
    ]);
  }

  status(): RerankerStatus {
    return {
      backend: RERANKER_BACKEND,
      ready: this.ready && isProcessRunning(this.child),
      runtime_pid: this.child?.pid ?? null,
      model_path: this.modelPath,
      llama_server_path: this.llamaServerPath,
      endpoint: this.endpoint,
      idle_timeout_ms: this.idleTimeoutMs,
      last_used_at: this.lastUsedAt > 0 ? new Date(this.lastUsedAt).toISOString() : null,
    };
  }

  async close(): Promise<void> {
    await this.stopServer("shutdown");
  }

  private assertReadyToSpawn(): void {
    verifyGguf(this.modelPath);
    const check = spawnSync(this.llamaServerPath, ["--version"], { stdio: "pipe", encoding: "utf-8" });
    if (check.error) {
      throw operationalError(`llama-server not found at ${this.llamaServerPath}; run pnpm run setup:reranker`);
    }
    if (check.status !== 0) {
      const detail = (check.stderr || check.stdout || "").trim();
      throw operationalError(`llama-server check failed at ${this.llamaServerPath}: ${detail}`);
    }
  }

  private async spawnServer(): Promise<void> {
    this.disarmIdleTimer();
    if (isProcessRunning(this.child)) await this.stopServer("restart");
    this.closing = false;
    this.ready = false;
    this.lastRuntimeError = null;
    this.stderrBuffer = "";
    this.stdoutBuffer = "";
    const port = this.configuredPort ?? (await findOpenPort(this.host));
    this.endpoint = `http://${this.host}:${port}`;
    const args = [
      "--model",
      this.modelPath,
      "--host",
      this.host,
      "--port",
      String(port),
      "--embedding",
      "--pooling",
      "rank",
      "--reranking",
      "--ctx-size",
      "2048",
      "--parallel",
      "1",
      "--no-webui",
    ];
    const child = spawn(this.llamaServerPath, args, {
      cwd: this.appRoot,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.stdoutBuffer = `${this.stdoutBuffer}${chunk.toString("utf-8")}`.slice(-8_000);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf-8")}`.slice(-8_000);
    });
    child.on("error", (err) => {
      this.failServer(operationalError(`llama-server spawn failed: ${messageText(err)}`));
    });
    child.on("close", (code, signal) => {
      if (this.closing) return;
      const detail = this.stderrBuffer.trim() || `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
      this.failServer(operationalError(`llama-server exited before shutdown: ${detail}`));
    });

    try {
      await this.waitForReady();
      this.ready = true;
      this.lastUsedAt = Date.now();
      this.armIdleTimer();
    } catch (err: unknown) {
      await this.stopServer("startup failure");
      throw err;
    } finally {
      this.startPromise = null;
    }
  }

  private async waitForReady(): Promise<void> {
    const deadline = Date.now() + this.startupTimeoutMs;
    let lastError = "not ready";
    while (Date.now() < deadline) {
      if (!isProcessRunning(this.child)) {
        throw (
          this.lastRuntimeError ??
          operationalError(`llama-server exited during startup: ${this.stderrBuffer.trim() || "no stderr"}`)
        );
      }
      try {
        const health = await fetchJson(`${this.endpoint}/health`, { method: "GET" }, 1_000);
        if (health.status === 200) {
          await this.rerankWithRunningServer("local memory reranker readiness", [
            { id: "relevant", text: "Qwen3 GGUF reranker serves local memory retrieval." },
            { id: "irrelevant", text: "A calendar reminder about lunch." },
          ]);
          return;
        }
        lastError = `health returned HTTP ${health.status}`;
      } catch (err: unknown) {
        lastError = messageText(err);
      }
      await sleep(500);
    }
    throw operationalError(`llama-server startup timed out after ${this.startupTimeoutMs} ms: ${lastError}`);
  }

  private async rerankWithRunningServer(query: string, candidates: RerankCandidateInput[]): Promise<RerankResult[]> {
    if (!this.endpoint || !isProcessRunning(this.child)) {
      throw this.lastRuntimeError ?? operationalError("llama-server runtime is not running");
    }
    this.activeRequests += 1;
    this.disarmIdleTimer();
    try {
      const documents = candidates.map((candidate) => candidate.text);
      const body = JSON.stringify({ model: "qwen3-reranker-0.6b-q4_k_m", query, documents });
      const endpoints = ["/reranking", "/v1/rerank"];
      const failures: string[] = [];
      for (const path of endpoints) {
        const response = await fetchJson(
          `${this.endpoint}${path}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          },
          this.requestTimeoutMs,
        );
        if (response.status >= 200 && response.status < 300) {
          const results = parseRerankApiResponse(response.body, candidates);
          this.lastUsedAt = Date.now();
          return results;
        }
        failures.push(`${path} HTTP ${response.status}: ${JSON.stringify(response.body).slice(0, 300)}`);
      }
      throw operationalError(`llama-server rerank failed: ${failures.join("; ")}`);
    } finally {
      this.activeRequests = Math.max(0, this.activeRequests - 1);
      this.armIdleTimer();
    }
  }

  private armIdleTimer(): void {
    this.disarmIdleTimer();
    if (!isProcessRunning(this.child) || this.activeRequests > 0) return;
    this.idleTimer = setTimeout(() => {
      if (this.activeRequests === 0) void this.stopServer("idle timeout");
    }, this.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private disarmIdleTimer(): void {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private async stopServer(_reason: string): Promise<void> {
    this.disarmIdleTimer();
    this.closing = true;
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.endpoint = null;
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await new Promise<void>((resolveStop) => {
      const timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGKILL");
        resolveStop();
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveStop();
      });
    });
  }

  private failServer(err: Error): void {
    this.ready = false;
    this.child = null;
    this.startPromise = null;
    this.endpoint = null;
    this.lastRuntimeError = err;
  }
}

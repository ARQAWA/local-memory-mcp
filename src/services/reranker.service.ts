import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
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
  ready: boolean;
  worker_pid: number | null;
  model_path: string;
}

interface JinaRerankerOptions {
  appRoot?: string | undefined;
  pythonPath?: string | undefined;
  workerPath?: string | undefined;
  modelPath?: string | undefined;
  startupTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingRequest {
  resolve: (results: RerankResult[]) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export const RERANKER_OPERATIONAL_ERROR = "memory is not operational without Jina MLX reranker";
export const DEFAULT_RERANKER_MODEL_PATH = join(
  homedir(),
  ".local",
  "share",
  "local-memory-mcp",
  "models",
  "jina-reranker-v3-mlx",
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

function operationalError(message: string): ExternalServiceError {
  return new ExternalServiceError("Jina MLX reranker", `${RERANKER_OPERATIONAL_ERROR}: ${message}`);
}

function messageText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseWorkerResults(value: unknown): RerankResult[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): RerankResult | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = record["id"];
      const score = record["score"];
      if (typeof id !== "string" || typeof score !== "number" || !Number.isFinite(score)) return null;
      return { id, score };
    })
    .filter((item): item is RerankResult => item !== null);
}

export class JinaRerankerService implements Reranker {
  readonly appRoot: string;
  readonly pythonPath: string;
  readonly workerPath: string;
  readonly modelPath: string;
  readonly startupTimeoutMs: number;
  readonly requestTimeoutMs: number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private ready = false;
  private readyWaiter: ReadyWaiter | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private closing = false;
  private pending = new Map<string, PendingRequest>();

  constructor(options?: JinaRerankerOptions) {
    this.appRoot = options?.appRoot ?? process.env["LOCAL_MEMORY_APP_ROOT"] ?? appRootFromImport();
    this.pythonPath =
      options?.pythonPath ??
      process.env["LOCAL_MEMORY_RERANKER_PYTHON"] ??
      join(this.appRoot, ".venv", "bin", "python");
    this.workerPath =
      options?.workerPath ??
      process.env["LOCAL_MEMORY_RERANKER_WORKER_PATH"] ??
      join(this.appRoot, "python", "jina_reranker_worker.py");
    this.modelPath =
      options?.modelPath ?? process.env["LOCAL_MEMORY_RERANKER_MODEL_PATH"] ?? DEFAULT_RERANKER_MODEL_PATH;
    this.startupTimeoutMs =
      options?.startupTimeoutMs ?? positiveInt(process.env["LOCAL_MEMORY_RERANKER_STARTUP_TIMEOUT_MS"], 120_000);
    this.requestTimeoutMs =
      options?.requestTimeoutMs ?? positiveInt(process.env["LOCAL_MEMORY_RERANKER_TIMEOUT_MS"], 60_000);
  }

  async start(): Promise<void> {
    if (this.ready) return;
    if (this.startPromise) return this.startPromise;
    this.assertReadyToSpawn();
    this.startPromise = this.spawnWorker();
    return this.startPromise;
  }

  async rerank(query: string, candidates: RerankCandidateInput[]): Promise<RerankResult[]> {
    await this.start();
    if (candidates.length === 0) return [];
    const child = this.child;
    if (!child || !this.ready) {
      throw operationalError("worker is not ready");
    }
    const id = randomUUID();
    const payload = { id, query, candidates };
    return new Promise<RerankResult[]>((resolveResult, rejectResult) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectResult(operationalError(`rerank request timed out after ${this.requestTimeoutMs} ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject: rejectResult, timer });
      child.stdin.write(`${JSON.stringify(payload)}\n`, (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(operationalError(`failed to write worker request: ${messageText(err)}`));
      });
    });
  }

  async healthCheck(): Promise<RerankResult[]> {
    return this.rerank("local memory reranker readiness", [
      { id: "relevant", text: "Local Memory MCP uses a mandatory Jina MLX reranker for retrieval." },
      { id: "irrelevant", text: "This passage talks about unrelated weather." },
    ]);
  }

  status(): RerankerStatus {
    return {
      ready: this.ready,
      worker_pid: this.child?.pid ?? null,
      model_path: this.modelPath,
    };
  }

  async close(): Promise<void> {
    this.closing = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(operationalError("worker is closing"));
      this.pending.delete(id);
    }
    if (this.readyWaiter) {
      clearTimeout(this.readyWaiter.timer);
      this.readyWaiter.reject(operationalError("worker is closing"));
      this.readyWaiter = null;
    }
    const child = this.child;
    this.child = null;
    this.ready = false;
    this.startPromise = null;
    if (child && !child.killed) child.kill("SIGTERM");
    await Promise.resolve();
  }

  private assertReadyToSpawn(): void {
    if (process.platform !== "darwin" || process.arch !== "arm64") {
      throw operationalError(`requires macOS Apple Silicon; got ${process.platform}/${process.arch}`);
    }
    if (!existsSync(this.pythonPath)) {
      throw operationalError(`Python venv not found at ${this.pythonPath}; run pnpm run setup:reranker`);
    }
    if (!existsSync(this.workerPath)) {
      throw operationalError(`worker not found at ${this.workerPath}`);
    }
    if (!existsSync(this.modelPath)) {
      throw operationalError(`model path not found at ${this.modelPath}; run pnpm run setup:reranker`);
    }
    if (!existsSync(join(this.modelPath, "rerank.py")) || !existsSync(join(this.modelPath, "projector.safetensors"))) {
      throw operationalError(`model path is incomplete at ${this.modelPath}; run pnpm run setup:reranker`);
    }
  }

  private spawnWorker(): Promise<void> {
    this.closing = false;
    this.stderrBuffer = "";
    this.stdoutBuffer = "";
    const child = spawn(this.pythonPath, [this.workerPath, "--model-path", this.modelPath], {
      cwd: this.appRoot,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    child.stdout.on("data", (chunk: Buffer) => {
      this.handleStdout(chunk.toString("utf-8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk.toString("utf-8")}`.slice(-8_000);
    });
    child.on("error", (err) => this.failWorker(operationalError(`worker spawn failed: ${messageText(err)}`)));
    child.on("close", (code, signal) => {
      if (this.closing) return;
      const detail = this.stderrBuffer.trim() || `exit code ${code ?? "null"}, signal ${signal ?? "null"}`;
      this.failWorker(operationalError(`worker exited before shutdown: ${detail}`));
    });

    return new Promise<void>((resolveReady, rejectReady) => {
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        rejectReady(operationalError(`worker startup timed out after ${this.startupTimeoutMs} ms`));
        this.startPromise = null;
      }, this.startupTimeoutMs);
      this.readyWaiter = {
        resolve: () => {
          clearTimeout(timer);
          resolveReady();
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          rejectReady(err);
        },
        timer,
      };
    });
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newlineIndex = this.stdoutBuffer.indexOf("\n");
    while (newlineIndex >= 0) {
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleWorkerLine(line);
      newlineIndex = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleWorkerLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      this.failWorker(operationalError(`worker emitted invalid JSON: ${line.slice(0, 200)}`));
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const message = parsed as Record<string, unknown>;
    if (message["type"] === "ready") {
      this.ready = true;
      const waiter = this.readyWaiter;
      this.readyWaiter = null;
      waiter?.resolve();
      return;
    }
    const id = message["id"];
    if (typeof id !== "string") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    const error = message["error"];
    if (typeof error === "string" && error.length > 0) {
      pending.reject(operationalError(error));
      return;
    }
    pending.resolve(parseWorkerResults(message["results"]));
  }

  private failWorker(err: Error): void {
    const waiter = this.readyWaiter;
    this.readyWaiter = null;
    waiter?.reject(err);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(err);
      this.pending.delete(id);
    }
    this.ready = false;
    this.child = null;
    this.startPromise = null;
  }
}

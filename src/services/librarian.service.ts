import { spawn } from "node:child_process";
import { ExternalServiceError } from "../errors.js";
import { logger } from "./logger.js";
import type { RerankCandidateInput } from "./reranker.service.js";

export type LibrarianMode = "off" | "auto" | "always";
export type LibrarianUse = "auto" | "never" | "always";

export interface LibrarianInput {
  task: string;
  mode: "light" | "deep";
  candidates: RerankCandidateInput[];
  use?: LibrarianUse | undefined;
}

export interface LibrarianOutput {
  sections: Record<string, string[]>;
  used_memory_ids: string[];
  confidence: number;
  missing_info: string[];
}

interface LibrarianRunnerOptions {
  env?: NodeJS.ProcessEnv | undefined;
}

function modeFromEnv(value: string | undefined): LibrarianMode {
  if (value === "always" || value === "auto" || value === "off") return value;
  return "off";
}

function timeoutFromEnv(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30_000;
}

function serviceError(message: string): ExternalServiceError {
  return new ExternalServiceError("Librarian subagent", message);
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function parseSections(value: unknown): Record<string, string[]> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result: Record<string, string[]> = {};
  for (const [key, sectionValue] of Object.entries(value)) {
    result[key] = parseStringArray(sectionValue);
  }
  return result;
}

function parseOutput(value: unknown): LibrarianOutput | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const sections = parseSections(record["sections"]);
  if (!sections) return null;
  const confidence = record["confidence"];
  return {
    sections,
    used_memory_ids: parseStringArray(record["used_memory_ids"]),
    confidence: typeof confidence === "number" && Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
    missing_info: parseStringArray(record["missing_info"]),
  };
}

export class LibrarianRunner {
  private readonly env: NodeJS.ProcessEnv;

  constructor(options?: LibrarianRunnerOptions) {
    this.env = options?.env ?? process.env;
  }

  async run(input: LibrarianInput): Promise<LibrarianOutput | null> {
    if (input.use === "never") return null;
    const envMode = modeFromEnv(this.env["LOCAL_MEMORY_LIBRARIAN_MODE"]);
    const mode: LibrarianMode = input.use === "always" ? "always" : envMode;
    if (mode === "off") return null;
    const command = this.env["LOCAL_MEMORY_LIBRARIAN_CMD"]?.trim();
    if (!command) {
      if (mode === "always") throw serviceError("LOCAL_MEMORY_LIBRARIAN_MODE=always but LOCAL_MEMORY_LIBRARIAN_CMD is empty");
      return null;
    }
    try {
      const output = await this.runJsonCommand(
        command,
        { task: input.task, mode: input.mode, candidates: input.candidates },
        timeoutFromEnv(this.env["LOCAL_MEMORY_LIBRARIAN_TIMEOUT_MS"]),
      );
      const parsed = parseOutput(output);
      if (!parsed) throw serviceError("command returned invalid librarian JSON");
      return parsed;
    } catch (err: unknown) {
      if (mode === "always") throw err;
      logger.warn("Librarian subagent failed; continuing without librarian pack", {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private runJsonCommand(command: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, { shell: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let done = false;
      const finish = (err: Error | null, value?: unknown): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (err) {
          reject(err);
          return;
        }
        resolve(value);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(serviceError(`command timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-4_000);
      });
      child.on("error", (err) => finish(serviceError(`command failed to start: ${err.message}`)));
      child.on("close", (code) => {
        if (code !== 0) {
          finish(serviceError(`command exited with ${code ?? "null"}: ${stderr.trim()}`));
          return;
        }
        try {
          finish(null, JSON.parse(stdout) as unknown);
        } catch (err: unknown) {
          finish(serviceError(`command returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`));
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}

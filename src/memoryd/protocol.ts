import type { RequestContext } from "../context.js";

export type MemorydMethod = "prepare_context" | "commit_task" | "correct_memory" | "health" | "doctor/status";

export interface MemorydRequest {
  id: string;
  method: MemorydMethod;
  params?: unknown;
  context?: RequestContext | undefined;
}

export interface MemorydErrorPayload {
  message: string;
  code?: string | undefined;
  statusCode?: number | undefined;
  detail?: string | undefined;
}

export type MemorydResponse =
  | {
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      id: string;
      ok: false;
      error: MemorydErrorPayload;
    };

export interface MemorydStatus {
  ok: true;
  pid: number;
  socket_path: string;
  pid_path: string;
  lock_path: string;
  log_path: string;
  database_path: string;
  app_root: string;
  uptime_seconds: number;
  reranker_backend: string;
  qwen_ready: boolean;
  qwen_runtime_pid: number | null;
  qwen_model_path: string;
  llama_server_path: string;
  reranker_endpoint: string | null;
  reranker_idle_timeout_ms: number;
  reranker_last_used_at: string | null;
}

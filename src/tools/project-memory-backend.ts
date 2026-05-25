import type { Memory, MemorySourceType, MemoryStatus } from "../types/memory.js";

export type PrepareMode = "auto" | "light" | "deep";
export type CorrectMemoryAction =
  | "mark_wrong"
  | "mark_deprecated"
  | "mark_superseded"
  | "mark_needs_review"
  | "mark_current";
export type LibrarianUse = "auto" | "never" | "always";

export interface PrepareContextInput {
  task: string;
  mode?: PrepareMode | undefined;
  repository?: string | undefined;
  working_context?: string | undefined;
  changed_files?: string[] | undefined;
  token_budget?: number | undefined;
  use_librarian?: LibrarianUse | undefined;
}

export interface PrepareContextOutput {
  context_pack: string;
  mode_used: "light" | "deep";
  sections: Record<string, string[]>;
  used_memory_ids: string[];
  confidence: number;
  missing_info: string[];
}

export interface CommitTaskItem {
  content: string;
  supersedes_id?: string | undefined;
  confidence?: number | undefined;
  anchors?: unknown[] | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface CommitTaskInput {
  task_summary: string;
  decisions?: (string | CommitTaskItem)[] | undefined;
  constraints?: (string | CommitTaskItem)[] | undefined;
  processes?: (string | CommitTaskItem)[] | undefined;
  gotchas?: (string | CommitTaskItem)[] | undefined;
  roadmap?: (string | CommitTaskItem)[] | undefined;
  changed_files?: string[] | undefined;
  open_questions?: string[] | undefined;
  repository?: string | undefined;
}

export interface CommitTaskOutput {
  created: number;
  skipped_duplicates: number;
  written_memory_ids: string[];
  open_questions: string[];
}

export interface CorrectMemoryInput {
  id: string;
  action: CorrectMemoryAction;
  confidence?: number | undefined;
  source_type?: MemorySourceType | undefined;
  supersedes_id?: string | undefined;
  repository?: string | undefined;
}

export type CorrectMemoryResult = Pick<Memory, "id" | "status" | "confidence" | "source_type" | "supersedes_id">;

export interface ProjectMemoryBackend {
  prepareContext(input: PrepareContextInput): Promise<PrepareContextOutput>;
  commitTask(input: CommitTaskInput): Promise<CommitTaskOutput>;
  correctMemory(input: CorrectMemoryInput): Promise<CorrectMemoryResult | null>;
}

export interface SerializedCorrectMemoryResult {
  id: string;
  status: MemoryStatus;
  confidence: number;
  source_type: MemorySourceType;
  supersedes_id: string | null;
}

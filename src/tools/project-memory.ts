import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContextOrDefault } from "../context.js";
import { memorySourceTypes } from "../types/memory.js";
import type { ProjectMemoryBackend } from "./project-memory-backend.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

const CommitItemSchema = z.union([
  z.string().min(1),
  z
    .object({
      content: z.string().min(1),
      supersedes_id: z.uuid().optional(),
      confidence: z.number().min(0).max(1).optional(),
      anchors: z.array(z.unknown()).optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })
    .strict(),
]);

export function registerProjectMemoryTools(server: McpServer, service: ProjectMemoryBackend) {
  server.registerTool(
    "prepare_context",
    {
      description:
        "Prepare a compact project-memory context pack for the next task. Light and deep retrieval both use the mandatory local Jina MLX reranker, singleton inside memoryd; deep mode can optionally use a librarian subagent after reranking.",
      inputSchema: {
        task: z.string().min(1).describe("Task or question to prepare context for"),
        mode: z.enum(["auto", "light", "deep"]).default("auto"),
        repository: z.string().optional().describe("Repository slug or UUID. Omit for current repository."),
        working_context: z.string().optional().describe("Extra current work context"),
        changed_files: z.array(z.string()).max(100).optional().describe("Files already known to be relevant"),
        token_budget: z.number().int().min(100).max(64000).optional().describe("Context pack budget"),
        use_librarian: z.enum(["auto", "never", "always"]).default("auto").describe("Per-call librarian preference"),
      },
      annotations: {
        title: "Prepare Project Context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const result = await service.prepareContext(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "prepare_context"),
  );

  server.registerTool(
    "commit_task",
    {
      description:
        "Commit durable task learnings into project memory cards. Writes only non-empty durable decisions, constraints, processes, gotchas, and roadmap items, and avoids duplicate cards.",
      inputSchema: {
        task_summary: z.string().min(1),
        decisions: z.array(CommitItemSchema).default([]),
        constraints: z.array(CommitItemSchema).default([]),
        processes: z.array(CommitItemSchema).default([]),
        gotchas: z.array(CommitItemSchema).default([]),
        roadmap: z.array(CommitItemSchema).default([]),
        changed_files: z.array(z.string()).max(100).default([]),
        open_questions: z.array(z.string()).max(100).default([]),
        repository: z.string().optional().describe("Repository slug or UUID. Omit for current repository."),
      },
      annotations: { title: "Commit Task Memory", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      getRequestContextOrDefault();
      const result = await service.commitTask(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "commit_task"),
  );

  server.registerTool(
    "correct_memory",
    {
      description:
        "Change project memory card status without rewriting the memory id. Actions mark a card wrong, deprecated, superseded, needs_review, or current.",
      inputSchema: {
        id: z.uuid(),
        action: z.enum(["mark_wrong", "mark_deprecated", "mark_superseded", "mark_needs_review", "mark_current"]),
        confidence: z.number().min(0).max(1).optional(),
        source_type: z.enum(memorySourceTypes).optional(),
        supersedes_id: z.uuid().optional(),
        repository: z.string().optional().describe("Repository slug or UUID. Omit for current repository."),
      },
      annotations: { title: "Correct Memory Card", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const result = await service.correctMemory(params);
      if (!result) return { content: [{ type: "text" as const, text: "Memory not found." }], isError: true };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              status: result.status,
              confidence: result.confidence,
              source_type: result.source_type,
              supersedes_id: result.supersedes_id,
            }),
          },
        ],
      };
    }, "correct_memory"),
  );
}

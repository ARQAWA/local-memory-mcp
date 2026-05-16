import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { tagsArraySchema } from "../types/memory.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireWritePermission, getRepoTags, mergeRepoTags } from "./util.js";
import { ValidationError } from "../errors.js";

export function registerSessionTools(server: McpServer, service: MemoryService) {
  // digest_session — extract multiple memories from a session summary
  server.registerTool(
    "digest_session",
    {
      description:
        "End-of-session capture: pass a summary of what you did, and Engram extracts facts, decisions, and learnings as separate memories. Much easier than calling remember multiple times.",
      inputSchema: {
        summary: z.string().min(10).max(50000).describe("Summary of what happened in this coding session"),
        tags: tagsArraySchema.describe("Optional tags to apply to all extracted memories"),
      },
      annotations: {
        title: "Digest Session",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const repoTags = getRepoTags();
      const baseTags = mergeRepoTags([...params.tags, "session-digest"], repoTags);

      // Use the service's digestSession method which handles LLM extraction + remember pipeline
      const digestInput: {
        summary: string;
        tags: string[];
        org_id: string;
        user_id?: string;
        team_slug?: string;
        created_by: string;
      } = {
        summary: params.summary,
        tags: baseTags,
        org_id: ctx.org_id,
        created_by: ctx.user_id,
      };
      if (ctx.user_id) {
        digestInput.user_id = ctx.user_id;
        digestInput.created_by = ctx.user_id;
      }
      if (ctx.team_slug) digestInput.team_slug = ctx.team_slug;

      const results = await service.digestSession(digestInput);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              extracted: results.length,
              memories: results.map((r) => ({
                id: r.id,
                memory_type: r.memory_type,
                summary: r.summary,
                dedup_action: r.dedup_action,
              })),
            }),
          },
        ],
      };
    }, "digest_session"),
  );

  // set_session_context — lightweight "I'm working on X"
  server.registerTool(
    "set_session_context",
    {
      description:
        "Set what you're currently working on. This persists as a short-lived episode and gets auto-surfaced in get_active_context for session continuity.",
      inputSchema: {
        goal: z.string().min(1).max(2000).describe("What you're currently working on"),
        files: z.array(z.string()).max(20).default([]).describe("Key files being worked on"),
        notes: z.string().max(5000).optional().describe("Additional context or notes"),
      },
      annotations: {
        title: "Set Session Context",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      if (!ctx.user_id) {
        throw new ValidationError("Personal scope requires an authenticated user (user_id is missing)");
      }
      const repoTags = getRepoTags();
      const files: string[] = params.files;
      const tags = mergeRepoTags(["session-context", ...files.map((f) => `file:${f}`)], repoTags);

      const content = [
        `**Current Goal:** ${params.goal}`,
        files.length > 0 ? `**Files:** ${files.join(", ")}` : null,
        params.notes ? `**Notes:** ${params.notes}` : null,
      ]
        .filter(Boolean)
        .join("\n");

      const result = await service.remember({
        content,
        memory_type: "episode",
        scope: "personal",
        tags,
        team_slug: ctx.team_slug,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
        created_by: ctx.user_id,
        source: "session-context",
        local_only: false,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              summary: result.summary,
              message: "Session context set. Will appear in get_active_context.",
            }),
          },
        ],
      };
    }, "set_session_context"),
  );
}

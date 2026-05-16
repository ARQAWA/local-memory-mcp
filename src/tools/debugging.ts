import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { tagsArraySchema } from "../types/memory.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireWritePermission, getRepoTags, mergeRepoTags } from "./util.js";

export function registerDebuggingTools(server: McpServer, service: MemoryService) {
  // log_resolution — structured capture of error debugging
  server.registerTool(
    "log_resolution",
    {
      description:
        "Record how you resolved an error or bug. Captures the error, root cause, and solution as a structured episode. These get boosted when similar errors appear later.",
      inputSchema: {
        error: z.string().min(1).max(10000).describe("The error message or symptoms encountered"),
        root_cause: z.string().min(1).max(10000).describe("What was actually wrong"),
        solution: z.string().min(1).max(10000).describe("How it was fixed"),
        files: z.array(z.string()).max(20).default([]).describe("Files involved in the fix"),
        tags: tagsArraySchema.describe("Additional tags"),
      },
      annotations: {
        title: "Log Error Resolution",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const repoTags = getRepoTags();

      const files: string[] = params.files;
      const content = `## Error Resolution

**Error:**
${params.error}

**Root Cause:**
${params.root_cause}

**Solution:**
${params.solution}
${files.length > 0 ? `\n**Files:** ${files.join(", ")}` : ""}`;

      const userTags: string[] = params.tags;
      const tags = mergeRepoTags([...userTags, "error-resolution", ...files.map((f) => `file:${f}`)], repoTags);

      const result = await service.remember({
        content,
        memory_type: "episode",
        scope: ctx.team_slug ? "team" : "personal",
        tags,
        team_slug: ctx.team_slug,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
        created_by: ctx.user_id,
        source: "error-resolution",
        local_only: false,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              summary: result.summary,
              importance: result.importance,
              dedup_action: result.dedup_action,
              tags: result.tags,
            }),
          },
        ],
      };
    }, "log_resolution"),
  );

  // get_similar_errors — specialized recall for error patterns
  server.registerTool(
    "get_similar_errors",
    {
      description:
        "Search for past error resolutions similar to a current error. Returns previous root causes and solutions for similar problems.",
      inputSchema: {
        error: z.string().min(1).max(10000).describe("The error message or symptoms you're seeing"),
        limit: z.number().min(1).max(20).default(5).describe("Max results"),
      },
      annotations: {
        title: "Get Similar Errors",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();

      const result = await service.recall({
        query: params.error,
        context: "debugging error resolution",
        tags: ["error-resolution"],
        team_slug: ctx.team_slug,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
        limit: params.limit,
        token_budget: 8000,
      });

      if (result.memories.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No similar error resolutions found. Use log_resolution to record how you fix this one.",
            },
          ],
        };
      }

      const formatted = result.memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        content: m.content,
        score: Math.round(m.composite_score * 1000) / 1000,
        tags: m.tags,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              query: params.error,
              count: formatted.length,
              resolutions: formatted,
            }),
          },
        ],
      };
    }, "get_similar_errors"),
  );
}

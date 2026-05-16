import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { tagsArraySchema } from "../types/memory.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireWritePermission, getRepoTags, mergeRepoTags } from "./util.js";
import { ValidationError } from "../errors.js";

export function registerCodingTools(server: McpServer, service: MemoryService) {
  // log_learning — quick-capture for coding agents
  server.registerTool(
    "log_learning",
    {
      description:
        "Quick-capture a learning from a coding session. Simpler than `remember` — just provide content. Auto-sets type to episode, scope to personal, merges repo tags.",
      inputSchema: {
        content: z.string().min(1).describe("What you learned or observed"),
        tags: tagsArraySchema.describe("Optional tags"),
      },
      annotations: {
        title: "Log Learning",
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

      const tags = mergeRepoTags([...params.tags, "coding-session"], getRepoTags());

      const result = await service.remember({
        content: params.content,
        memory_type: "episode",
        scope: "personal",
        tags,
        team_slug: ctx.team_slug,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
        created_by: ctx.user_id,
        source: "coding-session",
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
    }, "log_learning"),
  );

  // batch_recall — multiple queries in one call
  server.registerTool(
    "batch_recall",
    {
      description:
        "Run multiple recall queries in a single call. Useful for gathering context on several topics at once. Results are grouped by query.",
      inputSchema: {
        queries: z
          .array(
            z.object({
              query: z.string().min(1).describe("What to search for"),
              context: z.string().optional().describe("Working context for this query"),
            }),
          )
          .min(1)
          .max(10)
          .describe("List of queries to run (1-10)"),
        token_budget: z
          .number()
          .min(100)
          .max(64000)
          .default(8000)
          .describe("Total token budget (divided evenly across queries)"),
        team_slug: z.string().optional().describe("Team scope"),
      },
      annotations: {
        title: "Batch Recall",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      const perQueryBudget = Math.floor(params.token_budget / params.queries.length);

      const queries = params.queries.map((q: { query: string; context?: string | undefined }) => ({
        query: q.query,
        ...(q.context !== undefined && { context: q.context }),
      }));

      // Use allSettled so partial failures don't discard successful results
      const settled = await Promise.allSettled(
        queries.map((q: { query: string; context?: string }) =>
          service.recall({
            query: q.query,
            context: q.context,
            team_slug,
            org_id: ctx.org_id,
            user_id: ctx.user_id,
            limit: 5,
            token_budget: perQueryBudget,
          }),
        ),
      );

      const grouped = settled.map((r, i) => {
        const q = queries[i] ?? { query: "", context: "" };
        if (r.status === "fulfilled") {
          return {
            query: q.query,
            count: r.value.memories.length,
            total_tokens: r.value.total_tokens,
            truncated: r.value.truncated,
            memories: r.value.memories.map(
              (m: {
                id: string;
                summary: string;
                content: string;
                memory_type: string;
                tags: string[];
                composite_score: number;
              }) => ({
                id: m.id,
                summary: m.summary,
                content: m.content,
                memory_type: m.memory_type,
                tags: m.tags,
                score: Math.round(m.composite_score * 1000) / 1000,
              }),
            ),
          };
        }
        return {
          query: q.query,
          count: 0,
          total_tokens: 0,
          truncated: false,
          memories: [],
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              total_queries: params.queries.length,
              total_results: grouped.reduce((sum, g) => sum + g.count, 0),
              results: grouped,
            }),
          },
        ],
      };
    }, "batch_recall"),
  );
}

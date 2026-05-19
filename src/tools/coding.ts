import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContextOrDefault } from "../context.js";
import { MemoryService } from "../services/memory.service.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

export function registerCodingTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "log_learning",
    {
      description: "Quick-capture a reusable coding lesson in the current repository.",
      inputSchema: { content: z.string().min(1), tags: z.array(z.string()).default([]) },
      annotations: { title: "Log Learning", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const result = await service.remember({
        content: params.content,
        memory_type: "episode",
        tags: ["learning", ...params.tags],
        created_by: ctx.user_id,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id: result.id, repository: result.repository_slug }) },
        ],
      };
    }, "log_learning"),
  );

  server.registerTool(
    "get_similar_errors",
    {
      description: "Search current repository memory for similar errors and previous resolutions.",
      inputSchema: { error: z.string().min(1), limit: z.number().min(1).max(20).default(5) },
      annotations: { title: "Get Similar Errors", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const result = await service.recall({
        query: params.error,
        repository_mode: "current",
        memory_type: "episode",
        tags: ["error-resolution"],
        limit: params.limit,
        token_budget: 4000,
        graph_mode: "auto",
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "get_similar_errors"),
  );
}

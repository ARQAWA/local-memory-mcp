import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContextOrDefault } from "../context.js";
import { MemoryService } from "../services/memory.service.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

export function registerDebuggingTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "log_resolution",
    {
      description: "Record how an error or bug was resolved in the current repository.",
      inputSchema: {
        error: z.string().min(1),
        root_cause: z.string().min(1),
        solution: z.string().min(1),
        files: z.array(z.string()).optional(),
        tags: z.array(z.string()).default([]),
      },
      annotations: { title: "Log Resolution", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const content = [
        `# Error Resolution: ${params.error}`,
        "",
        `## Root Cause\n${params.root_cause}`,
        "",
        `## Solution\n${params.solution}`,
        params.files?.length ? `\n## Files\n${params.files.map((f) => `- ${f}`).join("\n")}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const result = await service.remember({
        content,
        memory_type: "episode",
        tags: ["error-resolution", ...params.tags, ...(params.files ?? []).map((file) => `file:${file}`)],
        created_by: ctx.user_id,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id: result.id, repository: result.repository_slug }) },
        ],
      };
    }, "log_resolution"),
  );
}

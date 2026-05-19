import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContextOrDefault } from "../context.js";
import { MemoryService } from "../services/memory.service.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

export function registerSessionTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "digest_session",
    {
      description: "Capture durable learnings from this coding session in the current repository.",
      inputSchema: { summary: z.string().min(1), tags: z.array(z.string()).default([]) },
      annotations: { title: "Digest Session", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const result = await service.digestSession({ ...params, created_by: ctx.user_id });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "digest_session"),
  );

  server.registerTool(
    "set_session_context",
    {
      description: "Record short-lived context about current work in the current repository.",
      inputSchema: {
        goal: z.string().min(1),
        files: z.array(z.string()).optional(),
        notes: z.string().optional(),
      },
      annotations: { title: "Set Session Context", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const content = [
        `Current work: ${params.goal}`,
        params.files?.length ? `Files: ${params.files.join(", ")}` : "",
        params.notes ? `Notes: ${params.notes}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const result = await service.remember({
        content,
        memory_type: "episode",
        tags: ["session-context", ...(params.files ?? []).map((file) => `file:${file}`)],
        ttl_days: 30,
        created_by: ctx.user_id,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify({ id: result.id, repository: result.repository_slug }) },
        ],
      };
    }, "set_session_context"),
  );
}

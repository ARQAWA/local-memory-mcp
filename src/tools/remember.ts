import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContextOrDefault } from "../context.js";
import { MemoryService } from "../services/memory.service.js";
import { memoryTypes, tagsArraySchema } from "../types/memory.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

export function registerRememberTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "remember",
    {
      description: "Record a memory in the current repository. Memories are repository-bound by default.",
      inputSchema: {
        content: z.string().min(1).describe("The knowledge to remember"),
        memory_type: z.enum(memoryTypes).describe("fact, decision, procedure, episode, reference, or convention"),
        tags: tagsArraySchema.describe("Classification tags"),
        importance: z.number().min(0).max(1).optional().describe("Importance score 0-1"),
        external_id: z.string().max(500).optional().describe("Idempotency key inside the current repository"),
        source: z.string().optional().describe("Where this knowledge came from"),
        ttl_days: z.number().int().min(1).max(3650).optional().describe("Auto-expire after this many days"),
        group_id: z.uuid().optional().describe("Group UUID"),
        sequence: z.number().int().min(0).optional().describe("Position in group"),
        group_type: z.string().max(50).optional().describe("Group type"),
      },
      annotations: { title: "Remember", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const result = await service.remember({ ...params, created_by: ctx.user_id });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              repository: result.repository_slug,
              summary: result.summary,
              memory_type: result.memory_type,
              importance: result.importance,
              dedup_action: result.dedup_action,
              tags: result.tags,
              created_at: result.created_at,
            }),
          },
        ],
      };
    }, "remember"),
  );

  server.registerTool(
    "remember_fact",
    {
      description: "Record an atomic fact in the current repository.",
      inputSchema: {
        fact: z.string().min(1).describe("The atomic fact to remember"),
        tags: tagsArraySchema.describe("Classification tags"),
      },
      annotations: { title: "Remember Fact", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const result = await service.rememberFact({ ...params, created_by: ctx.user_id });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              repository: result.repository_slug,
              fact: result.summary,
              dedup_action: result.dedup_action,
              importance: result.importance,
              tags: result.tags,
            }),
          },
        ],
      };
    }, "remember_fact"),
  );

  server.registerTool(
    "remember_decision",
    {
      description: "Record an architectural decision in the current repository.",
      inputSchema: {
        title: z.string().min(1).describe("Decision title"),
        context: z.string().min(1).describe("What prompted this decision"),
        decision: z.string().min(1).describe("What was decided"),
        rationale: z.string().min(1).describe("Why this was decided"),
        alternatives: z.string().optional().describe("Alternatives considered"),
        tags: tagsArraySchema.describe("Classification tags"),
      },
      annotations: { title: "Remember Decision", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const result = await service.rememberDecision({ ...params, created_by: ctx.user_id });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              repository: result.repository_slug,
              supersedes: result.supersedes,
              summary: result.summary,
              memory_type: result.memory_type,
              dedup_action: result.dedup_action,
            }),
          },
        ],
      };
    }, "remember_decision"),
  );
}

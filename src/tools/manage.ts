import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { memoryTypes, memoryScopes, relationTypes, tagsFilterSchema } from "../types/memory.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireWritePermission } from "./util.js";
import { logger } from "../services/logger.js";

export function registerManageTools(server: McpServer, service: MemoryService) {
  // forget — soft-invalidate a memory
  server.registerTool(
    "forget",
    {
      description:
        "Soft-invalidate a memory (sets valid_until to now). The memory is preserved but no longer returned in recall. Never hard-deletes.",
      inputSchema: {
        id: z.uuid().describe("Memory UUID to forget"),
        reason: z.string().optional().describe("Why this memory is being forgotten"),
      },
      annotations: {
        title: "Forget Memory",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const forgotten = await service.forget(
        {
          id: params.id,
          reason: params.reason,
          actor: ctx.user_id,
        },
        ctx.org_id,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: forgotten
              ? "Memory forgotten (soft-invalidated, preserved in history)."
              : "Memory not found or already forgotten.",
          },
        ],
        isError: !forgotten,
      };
    }, "forget"),
  );

  // batch_forget — soft-invalidate multiple memories in one call
  server.registerTool(
    "batch_forget",
    {
      description:
        "Soft-invalidate multiple memories in a single call. Each memory is processed independently — partial success is possible. Returns per-ID results.",
      inputSchema: {
        ids: z
          .array(z.uuid())
          .min(1)
          .max(100)
          .describe("Memory UUIDs to forget (1–100)"),
        reason: z.string().max(5000).optional().describe("Why these memories are being forgotten (applied to all)"),
      },
      annotations: {
        title: "Batch Forget Memories",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();

      const settled = await Promise.allSettled(
        params.ids.map((id: string) =>
          service.forget(
            {
              id,
              reason: params.reason,
              actor: ctx.user_id,
            },
            ctx.org_id,
          ),
        ),
      );

      const results = settled.map((r, i) => {
        const id = params.ids[i]!;
        if (r.status === "fulfilled") {
          return r.value
            ? { id, success: true as const }
            : { id, success: false as const, error: "Memory not found or already forgotten." };
        }
        logger.warn("batch_forget: individual forget failed", {
          memory_id: id,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          stack: r.reason instanceof Error ? r.reason.stack : undefined,
        });
        return {
          id,
          success: false as const,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        };
      });

      const forgotten = results.filter((r) => r.success).length;
      const failed = results.length - forgotten;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ forgotten, failed, results }),
          },
        ],
        isError: forgotten === 0 && failed > 0,
      };
    }, "batch_forget"),
  );

  // correct — supersede a memory with corrected info
  server.registerTool(
    "correct",
    {
      description:
        "Supersede a memory with corrected information. Invalidates the old memory and creates a new one linked via 'supersedes'.",
      inputSchema: {
        id: z.uuid().describe("Memory UUID to correct"),
        new_content: z.string().min(1).describe("Corrected content"),
        reason: z.string().optional().describe("Why this correction is being made"),
      },
      annotations: {
        title: "Correct Memory",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const corrected = await service.correct(
        {
          id: params.id,
          new_content: params.new_content,
          reason: params.reason,
          actor: ctx.user_id,
        },
        ctx.org_id,
      );
      if (!corrected) {
        return {
          content: [{ type: "text" as const, text: "Original memory not found." }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              new_id: corrected.id,
              supersedes: params.id,
              summary: corrected.summary,
              memory_type: corrected.memory_type,
            }),
          },
        ],
      };
    }, "correct"),
  );

  // list_memories — browse with filters
  server.registerTool(
    "list_memories",
    {
      description: "Browse memories with filters by scope, type, tags, team, and date.",
      inputSchema: {
        scope: z.enum(memoryScopes).optional().describe("Filter by scope"),
        memory_type: z.enum(memoryTypes).optional().describe("Filter by memory type"),
        tags: tagsFilterSchema.describe("Filter by tags"),
        team_slug: z.string().optional().describe("Filter by team"),
        since: z.iso.datetime({ offset: true }).optional().describe("Only memories created after this ISO date"),
        local_only: z
          .boolean()
          .optional()
          .describe("Filter by local_only flag (true = only local, false = only synced)"),
        limit: z.number().min(1).max(100).default(20).describe("Max results"),
        offset: z.number().min(0).default(0).describe("Pagination offset"),
      },
      annotations: {
        title: "List Memories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      const memories = await service.listMemories({
        ...params,
        team_slug,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
      });

      const summaries = memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        memory_type: m.memory_type,
        scope: m.scope,
        tags: m.tags,
        importance: Math.round(m.importance * 100) / 100,
        access_count: m.access_count,
        updated_at: m.updated_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: summaries.length,
              memories: summaries,
            }),
          },
        ],
      };
    }, "list_memories"),
  );

  // search_memories — explicit search
  server.registerTool(
    "search_memories",
    {
      description:
        "Search memories using full-text and semantic similarity. For explicit search; use 'recall' for smart ranked retrieval.",
      inputSchema: {
        query: z.string().min(1).describe("Search query"),
        scope: z.enum(memoryScopes).optional().describe("Filter by scope"),
        memory_type: z.enum(memoryTypes).optional().describe("Filter by memory type"),
        tags: tagsFilterSchema.describe("Filter by tags"),
        team_slug: z.string().optional().describe("Filter by team"),
        local_only: z
          .boolean()
          .optional()
          .describe("Filter by local_only flag (true = only local, false = only synced)"),
        limit: z.number().min(1).max(50).default(10).describe("Max results"),
      },
      annotations: {
        title: "Search Memories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      const results = await service.searchMemories({
        ...params,
        team_slug,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
      });

      const formatted = results.map((r) => ({
        id: r.id,
        summary: r.summary,
        memory_type: r.memory_type,
        scope: r.scope,
        tags: r.tags,
        score: Math.round(r.score * 1000) / 1000,
        match_type: r.match_type,
        created_at: r.created_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              query: params.query,
              count: formatted.length,
              results: formatted,
            }),
          },
        ],
      };
    }, "search_memories"),
  );

  // get_memory_stats — dashboard
  server.registerTool(
    "get_memory_stats",
    {
      description: "Get memory statistics: counts by type/scope, most accessed, stale count.",
      inputSchema: {
        team_slug: z.string().optional().describe("Filter stats by team"),
      },
      annotations: {
        title: "Get Memory Stats",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      const stats = await service.getMemoryStats(ctx.org_id, team_slug);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(stats),
          },
        ],
      };
    }, "get_memory_stats"),
  );

  // link_memories — create a relationship between memories
  server.registerTool(
    "link_memories",
    {
      description:
        "Create a typed relationship between two memories (supersedes, depends_on, related_to, implements, alternative_to, contradicts).",
      inputSchema: {
        source_id: z.uuid().describe("Source memory UUID"),
        target_id: z.uuid().describe("Target memory UUID"),
        relation_type: z.enum(relationTypes).describe("Relationship type"),
        description: z.string().optional().describe("Optional description of the relationship"),
      },
      annotations: {
        title: "Link Memories",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const relation = await service.linkMemories(
        params.source_id,
        params.target_id,
        params.relation_type,
        params.description,
        ctx.org_id,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(relation),
          },
        ],
      };
    }, "link_memories"),
  );

  // get_related — get all related memories
  server.registerTool(
    "get_related",
    {
      description: "Get all memories related to a given memory, with relationship types.",
      inputSchema: {
        memory_id: z.uuid().describe("Memory UUID"),
      },
      annotations: {
        title: "Get Related Memories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async ({ memory_id }) => {
      const ctx = getRequestContextOrDefault();
      const relations = await service.getRelated(memory_id, ctx.org_id);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              memory_id,
              count: relations.length,
              relations,
            }),
          },
        ],
      };
    }, "get_related"),
  );

  // get_group — fetch all memories in an ordered group
  server.registerTool(
    "get_group",
    {
      description:
        "Fetch all memories in an ordered group by group_id. Returns memories sorted by sequence number. Supports windowed retrieval around a specific sequence position.",
      inputSchema: {
        group_id: z.uuid().describe("Group UUID"),
        window: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Number of memories to return around the 'around' sequence position"),
        around: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Sequence number to center the window on (requires 'window')"),
      },
      annotations: {
        title: "Get Memory Group",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const groupOptions: { window?: number; around?: number } = {};
      if (params.window !== undefined) groupOptions.window = params.window;
      if (params.around !== undefined) groupOptions.around = params.around;
      const memories = await service.getGroupMemories(params.group_id, ctx.org_id, groupOptions);

      if (memories.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No memories found in group: ${params.group_id}`,
            },
          ],
        };
      }

      const formatted = memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        content: m.content,
        memory_type: m.memory_type,
        scope: m.scope,
        tags: m.tags,
        importance: Math.round(m.importance * 100) / 100,
        sequence: m.sequence,
        group_type: m.group_type,
        created_at: m.created_at,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              group_id: params.group_id,
              group_type: memories[0]?.group_type ?? null,
              count: formatted.length,
              memories: formatted,
            }),
          },
        ],
      };
    }, "get_group"),
  );

  // consolidate — background memory consolidation
  server.registerTool(
    "consolidate",
    {
      description:
        "Run background consolidation: recalculate importance scores for stale memories. Designed to be run periodically or on-demand.",
      inputSchema: {
        team_slug: z.string().optional().describe("Team slug to scope consolidation (optional, defaults to all)"),
      },
      annotations: {
        title: "Consolidate Memories",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      const result = await service.consolidate(ctx.org_id, team_slug);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "complete",
              recalculated: result.recalculated,
              errors: result.errors,
            }),
          },
        ],
      };
    }, "consolidate"),
  );
}

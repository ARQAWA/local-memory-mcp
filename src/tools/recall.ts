import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { memoryTypes, memoryScopes, tagsFilterSchema } from "../types/memory.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling } from "./util.js";

export function registerRecallTools(server: McpServer, service: MemoryService) {
  // recall — the primary read tool
  server.registerTool(
    "recall",
    {
      description:
        "Smart retrieval of relevant memories. Combines semantic similarity, keyword matching, recency, and importance. Use this as your primary way to pull context.",
      inputSchema: {
        query: z.string().min(1).describe("What are you looking for?"),
        context: z.string().optional().describe("What you're currently working on (improves relevance)"),
        scope: z.enum(memoryScopes).optional().describe("Filter to a specific scope"),
        team_slug: z.string().optional().describe("Filter to a specific team"),
        memory_type: z.enum(memoryTypes).optional().describe("Filter by memory type"),
        tags: tagsFilterSchema.describe("Filter by tags"),
        limit: z.number().min(1).max(50).default(10).describe("Max memories to return"),
        token_budget: z.number().min(100).max(64000).default(4000).describe("Max tokens in response"),
      },
      annotations: {
        title: "Recall Memories",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      const result = await service.recall({
        ...params,
        team_slug,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
      });

      const formatted = result.memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        content: m.content,
        memory_type: m.memory_type,
        scope: m.scope,
        tags: m.tags,
        importance: Math.round(m.importance * 100) / 100,
        score: Math.round(m.composite_score * 1000) / 1000,
        created_at: m.created_at,
        ...(m.group_id
          ? {
              group_id: m.group_id,
              sequence: m.sequence,
              group_type: m.group_type,
            }
          : {}),
      }));

      const formattedRelated = (result.related ?? []).map((m) => ({
        id: m.id,
        summary: m.summary,
        memory_type: m.memory_type,
        scope: m.scope,
        tags: m.tags,
        importance: Math.round(m.importance * 100) / 100,
        relation: "graph_1hop",
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              query: result.query,
              count: formatted.length,
              total_tokens: result.total_tokens,
              truncated: result.truncated,
              memories: formatted,
              related: formattedRelated.length > 0 ? formattedRelated : undefined,
            }),
          },
        ],
      };
    }, "recall"),
  );

  // get_active_context — always-in-context block (call at session start)
  server.registerTool(
    "get_active_context",
    {
      description:
        "Get the team's active knowledge block — conventions, recent decisions, key facts. Call at session start. Optionally specify what you're working on for targeted context.",
      inputSchema: {
        team_slug: z.string().optional().describe("Team slug"),
        working_on: z
          .string()
          .optional()
          .describe(
            "What you're currently working on (file path, feature, or topic). Adds targeted context alongside team conventions.",
          ),
        token_budget: z.number().min(100).max(64000).default(4000).describe("Max tokens"),
      },
      annotations: {
        title: "Get Active Context",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      const result = await service.getActiveContext(
        ctx.org_id,
        team_slug,
        params.token_budget,
        params.working_on,
        ctx.user_id,
      );

      if (result.memories.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No active context found. Start recording memories with `remember` to build up context.",
            },
          ],
        };
      }

      const formatted = result.memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        content: m.content,
        memory_type: m.memory_type,
        scope: m.scope,
        tags: m.tags,
        importance: Math.round(m.importance * 100) / 100,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              team_slug: team_slug ?? null,
              count: formatted.length,
              total_tokens: result.total_tokens,
              truncated: result.truncated,
              memories: formatted,
            }),
          },
        ],
      };
    }, "get_active_context"),
  );

  // get_context_for — auto-retrieval for a topic
  server.registerTool(
    "get_context_for",
    {
      description: "Get everything relevant to working on a topic or file path. Returns a curated context block.",
      inputSchema: {
        topic: z.string().min(1).describe("Topic or file path to get context for"),
        team_slug: z.string().optional().describe("Team scope"),
        limit: z.number().min(1).max(20).default(10).describe("Max memories"),
        token_budget: z.number().min(100).max(64000).default(4000).describe("Max tokens in response"),
      },
      annotations: {
        title: "Get Context For Topic",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      const result = await service.getContextFor({
        ...params,
        team_slug,
        org_id: ctx.org_id,
        user_id: ctx.user_id,
      });

      if (result.memories.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No relevant memories found for topic: "${params.topic}"`,
            },
          ],
        };
      }

      const formatted = result.memories.map((m) => ({
        id: m.id,
        summary: m.summary,
        content: m.content,
        memory_type: m.memory_type,
        scope: m.scope,
        tags: m.tags,
        importance: Math.round(m.importance * 100) / 100,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              topic: params.topic,
              count: formatted.length,
              total_tokens: result.total_tokens,
              truncated: result.truncated,
              memories: formatted,
            }),
          },
        ],
      };
    }, "get_context_for"),
  );

  // get_memory — fetch a specific memory by ID
  server.registerTool(
    "get_memory",
    {
      description: "Fetch a specific memory by ID for drill-down after recall. Includes related memories.",
      inputSchema: {
        id: z.uuid().describe("Memory UUID"),
      },
      annotations: {
        title: "Get Memory By ID",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async ({ id }) => {
      const ctx = getRequestContextOrDefault();
      const memory = await service.getMemory(id, ctx.org_id);
      if (!memory) {
        return {
          content: [{ type: "text" as const, text: "Memory not found." }],
          isError: true,
        };
      }

      const relations = await service.getRelated(id, ctx.org_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...memory, relations }),
          },
        ],
      };
    }, "get_memory"),
  );

  // get_team_overview — team knowledge summary
  server.registerTool(
    "get_team_overview",
    {
      description: "Get a summary of a team's knowledge: key decisions, active conventions, recent changes.",
      inputSchema: {
        team_slug: z.string().optional().describe("Team slug (defaults to configured team)"),
      },
      annotations: {
        title: "Get Team Overview",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;
      if (!team_slug) {
        return {
          content: [
            {
              type: "text" as const,
              text: "Error: team_slug is required (provide it as a parameter or configure it in ~/.engram/config.json).",
            },
          ],
          isError: true,
        };
      }
      const overview = await service.getTeamOverview(team_slug, ctx.org_id);
      if (!overview) {
        return {
          content: [{ type: "text" as const, text: "Team not found." }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(overview),
          },
        ],
      };
    }, "get_team_overview"),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContext } from "../context.js";
import { MemoryService } from "../services/memory.service.js";
import { graphModes, memoryTypes, repositoryReadModes, tagsFilterSchema } from "../types/memory.js";
import { withErrorHandling } from "./util.js";

const repositorySelector = {
  repository_mode: z
    .enum(repositoryReadModes)
    .default("current")
    .describe("Default current. Use specific/all only when explicitly requested."),
  repository: z.string().optional().describe("Repository slug or UUID for repository_mode=specific."),
};

function compactMemory(m: {
  id: string;
  repository_slug: string | null;
  summary: string;
  content?: string;
  memory_type: string;
  tags: string[];
  importance: number;
  composite_score?: number;
  created_at?: Date;
  group_id?: string | null;
  sequence?: number | null;
  group_type?: string | null;
  relation_source?: string | undefined;
  relation_type?: string | undefined;
  relation_reason?: string | undefined;
  confidence?: number | undefined;
  content_mode?: string | undefined;
  token_cost_estimate?: number | undefined;
}) {
  return {
    id: m.id,
    repository: m.repository_slug,
    summary: m.summary,
    content: m.content,
    memory_type: m.memory_type,
    tags: m.tags,
    importance: Math.round(m.importance * 100) / 100,
    score: m.composite_score === undefined ? undefined : Math.round(m.composite_score * 1000) / 1000,
    created_at: m.created_at,
    ...(m.group_id ? { group_id: m.group_id, sequence: m.sequence, group_type: m.group_type } : {}),
    ...(m.relation_source
      ? {
          relation_source: m.relation_source,
          relation_type: m.relation_type,
          relation_reason: m.relation_reason,
          confidence: m.confidence,
          content_mode: m.content_mode,
          token_cost_estimate: m.token_cost_estimate,
        }
      : {}),
  };
}

export function registerRecallTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "recall",
    {
      description:
        "Smart retrieval from repository memory. Use before analysis, planning, editing, review, or answering from repository knowledge. Defaults to the current repository; use repository_mode=specific/all only on explicit request.",
      inputSchema: {
        query: z.string().min(1).describe("What are you looking for?"),
        context: z.string().optional().describe("What you're currently working on"),
        ...repositorySelector,
        memory_type: z.enum(memoryTypes).optional().describe("Filter by memory type"),
        tags: tagsFilterSchema.describe("Filter by tags"),
        limit: z.number().min(1).max(50).default(10).describe("Max memories to return"),
        token_budget: z.number().min(100).max(64000).default(4000).describe("Max tokens in response"),
        graph_mode: z.enum(graphModes).default("hard").describe("Graph enrichment mode: off, hard, auto, or full."),
      },
      annotations: { title: "Recall Memories", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const result = await service.recall(params);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              query: result.query,
              graph_mode: result.graph_mode,
              count: result.memories.length,
              total_tokens: result.total_tokens,
              truncated: result.truncated,
              memories: result.memories.map(compactMemory),
              related: result.related?.length ? result.related.map(compactMemory) : undefined,
            }),
          },
        ],
      };
    }, "recall"),
  );

  server.registerTool(
    "get_active_context",
    {
      description:
        "Get active knowledge for the current repository. Call before any task because Local Memory MCP is the agent core. Can search another repository only when repository_mode is explicit.",
      inputSchema: {
        ...repositorySelector,
        working_on: z.string().optional().describe("Current file, feature, or topic"),
        token_budget: z.number().min(100).max(64000).default(4000).describe("Max tokens"),
      },
      annotations: { title: "Get Active Context", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const result = await service.getActiveContext(params.token_budget, params.working_on, params);
      if (result.memories.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                repository: result.repository?.slug ?? null,
                count: 0,
                memories: [],
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              repository: result.repository?.slug ?? null,
              count: result.memories.length,
              total_tokens: result.total_tokens,
              truncated: result.truncated,
              memories: result.memories.map(compactMemory),
            }),
          },
        ],
      };
    }, "get_active_context"),
  );

  server.registerTool(
    "get_context_for",
    {
      description:
        "Get repository memory relevant to a topic or file path. Use for focused retrieval before planning, edits, audits, reviews, or code explanation.",
      inputSchema: {
        topic: z.string().min(1).describe("Topic or file path"),
        ...repositorySelector,
        limit: z.number().min(1).max(20).default(10).describe("Max memories"),
        token_budget: z.number().min(100).max(64000).default(4000).describe("Max tokens"),
        graph_mode: z.enum(graphModes).optional().describe("Optional graph enrichment mode"),
      },
      annotations: { title: "Get Context For Topic", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const result = await service.getContextFor(params);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              topic: result.topic,
              count: result.memories.length,
              total_tokens: result.total_tokens,
              truncated: result.truncated,
              memories: result.memories.map(compactMemory),
            }),
          },
        ],
      };
    }, "get_context_for"),
  );

  server.registerTool(
    "get_memory",
    {
      description: "Fetch a specific memory by ID and its direct relations.",
      inputSchema: {
        id: z.uuid().describe("Memory UUID"),
        ...repositorySelector,
      },
      annotations: { title: "Get Memory By ID", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async ({ id, repository_mode, repository }) => {
      const resolved = await service.resolveRepository({ repository_mode, repository });
      const memory = await service.getMemory(id, resolved.repository_id, { includeInvalidated: false });
      if (!memory) return { content: [{ type: "text" as const, text: "Memory not found." }], isError: true };
      const relations = await service.getRelated(id, resolved.repository_id ?? memory.repository_id, {
        mode: "lineage",
      });
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...memory, relations }) }] };
    }, "get_memory"),
  );

  server.registerTool(
    "get_repository_overview",
    {
      description: "Get the current repository memory summary and statistics.",
      inputSchema: { ...repositorySelector },
      annotations: { title: "Repository Overview", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContext();
      const stats = await service.getMemoryStats(params);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              current_repository: stats.repository?.slug ?? ctx?.repository.repository_slug ?? null,
              stats,
            }),
          },
        ],
      };
    }, "get_repository_overview"),
  );
}

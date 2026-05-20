import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContextOrDefault } from "../context.js";
import { MemoryService } from "../services/memory.service.js";
import { memoryTypes, relatedModes, relationTypes, repositoryReadModes, tagsFilterSchema } from "../types/memory.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

const repositorySelector = {
  repository_mode: z.enum(repositoryReadModes).default("current"),
  repository: z.string().optional(),
};

export function registerManageTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "forget",
    {
      description:
        "Soft-invalidate a stale, wrong, noisy, or irrelevant memory in its repository as part of memory hygiene.",
      inputSchema: { id: z.uuid(), reason: z.string().optional() },
      annotations: { title: "Forget Memory", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const repository = await service.currentRepository();
      const forgotten = await service.forget({ ...params, actor: ctx.user_id }, repository.id);
      return {
        content: [{ type: "text" as const, text: forgotten ? "Memory forgotten." : "Memory not found." }],
        isError: !forgotten,
      };
    }, "forget"),
  );

  server.registerTool(
    "batch_forget",
    {
      description: "Soft-invalidate multiple stale, wrong, noisy, or irrelevant memories as part of memory hygiene.",
      inputSchema: { ids: z.array(z.uuid()).min(1).max(100), reason: z.string().max(5000).optional() },
      annotations: { title: "Batch Forget Memories", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const repository = await service.currentRepository();
      const results = [];
      for (const id of params.ids) {
        const success = await service.forget({ id, reason: params.reason, actor: ctx.user_id }, repository.id);
        results.push({ id, success });
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              forgotten: results.filter((r) => r.success).length,
              failed: results.filter((r) => !r.success).length,
              results,
            }),
          },
        ],
      };
    }, "batch_forget"),
  );

  server.registerTool(
    "correct",
    {
      description:
        "Supersede a stale or wrong memory with corrected information in the same repository. Prefer this over writing a competing truth beside the old one.",
      inputSchema: { id: z.uuid(), new_content: z.string().min(1), reason: z.string().optional() },
      annotations: { title: "Correct Memory", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const repository = await service.currentRepository();
      const corrected = await service.correct({ ...params, actor: ctx.user_id }, repository.id);
      if (!corrected)
        return { content: [{ type: "text" as const, text: "Original memory not found." }], isError: true };
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              new_id: corrected.id,
              repository: corrected.repository_slug,
              supersedes: params.id,
              summary: corrected.summary,
            }),
          },
        ],
      };
    }, "correct"),
  );

  server.registerTool(
    "list_memories",
    {
      description: "Browse memories by repository, type, tags, and date.",
      inputSchema: {
        ...repositorySelector,
        memory_type: z.enum(memoryTypes).optional(),
        tags: tagsFilterSchema,
        since: z.iso.datetime({ offset: true }).optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      },
      annotations: { title: "List Memories", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const memories = await service.listMemories(params);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: memories.length,
              memories: memories.map((m) => ({
                id: m.id,
                repository: m.repository_slug,
                summary: m.summary,
                memory_type: m.memory_type,
                tags: m.tags,
                importance: Math.round(m.importance * 100) / 100,
                access_count: m.access_count,
                updated_at: m.updated_at,
              })),
            }),
          },
        ],
      };
    }, "list_memories"),
  );

  server.registerTool(
    "search_memories",
    {
      description: "Explicit search over repository memory.",
      inputSchema: {
        query: z.string().min(1),
        ...repositorySelector,
        memory_type: z.enum(memoryTypes).optional(),
        tags: tagsFilterSchema,
        limit: z.number().min(1).max(100).default(20),
      },
      annotations: { title: "Search Memories", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const memories = await service.searchMemories(params);
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: memories.length, memories }) }] };
    }, "search_memories"),
  );

  server.registerTool(
    "get_memory_stats",
    {
      description: "Get memory statistics by repository and type.",
      inputSchema: { ...repositorySelector },
      annotations: { title: "Memory Stats", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const stats = await service.getMemoryStats(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(stats) }] };
    }, "get_memory_stats"),
  );

  server.registerTool(
    "list_repositories",
    {
      description: "List repositories known to the local memory database.",
      inputSchema: {},
      annotations: { title: "List Repositories", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async () => {
      const repositories = await service.listRepositories();
      return { content: [{ type: "text" as const, text: JSON.stringify({ repositories }) }] };
    }, "list_repositories"),
  );

  server.registerTool(
    "link_memories",
    {
      description:
        "Create a strong explicit relation between two memories in the same repository. Do not link just because memories share a tag, file, entity, topic, or search result.",
      inputSchema: {
        source_id: z.uuid(),
        target_id: z.uuid(),
        relation_type: z.enum(relationTypes),
        description: z.string().optional(),
      },
      annotations: { title: "Link Memories", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const repository = await service.currentRepository();
      const relation = await service.linkMemories(
        params.source_id,
        params.target_id,
        params.relation_type,
        params.description,
        repository.id,
      );
      return { content: [{ type: "text" as const, text: JSON.stringify(relation) }] };
    }, "link_memories"),
  );

  server.registerTool(
    "get_related",
    {
      description: "Get all memories directly related to a memory.",
      inputSchema: {
        memory_id: z.uuid(),
        ...repositorySelector,
        mode: z.enum(relatedModes).default("active"),
      },
      annotations: { title: "Get Related Memories", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async ({ memory_id, repository_mode, repository, mode }) => {
      const resolved = await service.resolveRepository({ repository_mode, repository });
      const memory = await service.getMemory(memory_id, resolved.repository_id, {
        includeInvalidated: mode !== "active",
      });
      if (!memory) return { content: [{ type: "text" as const, text: "Memory not found." }], isError: true };
      const relations = await service.getRelated(memory_id, resolved.repository_id ?? memory.repository_id, { mode });
      return { content: [{ type: "text" as const, text: JSON.stringify(relations) }] };
    }, "get_related"),
  );

  server.registerTool(
    "get_group",
    {
      description: "Fetch memories in an ordered group.",
      inputSchema: {
        ...repositorySelector,
        group_id: z.uuid(),
        around: z.number().int().min(0).optional(),
        window: z.number().int().min(1).max(100).optional(),
      },
      annotations: { title: "Get Memory Group", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const resolved = await service.resolveRepository(params);
      const options =
        params.around !== undefined && params.window
          ? { seqMin: Math.max(0, params.around - params.window), seqMax: params.around + params.window }
          : undefined;
      const memories = await service.getGroupMemories(params.group_id, resolved.repository_id, options);
      return { content: [{ type: "text" as const, text: JSON.stringify({ count: memories.length, memories }) }] };
    }, "get_group"),
  );

  server.registerTool(
    "consolidate",
    {
      description: "Recalculate importance scores in repository memory after substantial memory changes or cleanup.",
      inputSchema: { ...repositorySelector },
      annotations: { title: "Consolidate Memory", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const result = await service.consolidate(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "consolidate"),
  );
}

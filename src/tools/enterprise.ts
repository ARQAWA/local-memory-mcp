import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { memoryTypes, repositoryReadModes } from "../types/memory.js";
import { requireAdminPermission, requireWritePermission, withErrorHandling } from "./util.js";

const repositorySelector = {
  repository_mode: z.enum(repositoryReadModes).default("current"),
  repository: z.string().optional(),
};

export function registerEnterpriseTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "query_entities",
    {
      description: "Search the repository knowledge graph.",
      inputSchema: {
        query: z.string().default(""),
        entity_type: z.enum(["service", "file", "package", "person", "concept", "api", "error", "env_var"]).optional(),
        ...repositorySelector,
        limit: z.number().min(1).max(100).default(20),
      },
      annotations: { title: "Query Entities", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const input: Parameters<typeof service.queryEntities>[0] = {
        query: params.query,
        repository_mode: params.repository_mode,
        limit: params.limit,
      };
      if (params.entity_type !== undefined) input.entityType = params.entity_type;
      if (params.repository !== undefined) input.repository = params.repository;
      const result = await service.queryEntities(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "query_entities"),
  );

  server.registerTool(
    "detect_conflicts",
    {
      description: "Scan repository memories for possible contradictions.",
      inputSchema: {
        memory_type: z.enum(memoryTypes).optional(),
        ...repositorySelector,
        limit: z.number().min(1).max(50).default(10),
      },
      annotations: { title: "Detect Conflicts", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const input: Parameters<typeof service.detectConflicts>[0] = {
        repository_mode: params.repository_mode,
        limit: params.limit,
      };
      if (params.memory_type !== undefined) input.memoryType = params.memory_type;
      if (params.repository !== undefined) input.repository = params.repository;
      const result = await service.detectConflicts(input);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "detect_conflicts"),
  );

  server.registerTool(
    "purge_memories",
    {
      description: "Hard-delete memories by user ID in the selected repository set. Requires admin.",
      inputSchema: { user_id: z.string().min(1), confirm: z.literal(true), ...repositorySelector },
      annotations: { title: "Purge Memories", readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireAdminPermission();
      const result = await service.purgeUserMemories(params.user_id, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "purge_memories"),
  );

  server.registerTool(
    "reembed_memories",
    {
      description: "Re-embed active memories in the selected repository set.",
      inputSchema: {
        confirm: z.literal(true),
        batch_size: z.number().min(1).max(1000).default(100),
        null_only: z.boolean().default(false),
        ...repositorySelector,
      },
      annotations: { title: "Re-embed Memories", readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const result = await service.reembedMemories(params.batch_size, params.null_only, params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "reembed_memories"),
  );

  server.registerTool(
    "get_memory_analytics",
    {
      description: "Get repository memory analytics.",
      inputSchema: { ...repositorySelector },
      annotations: { title: "Memory Analytics", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const result = await service.getAnalytics(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "get_memory_analytics"),
  );
}

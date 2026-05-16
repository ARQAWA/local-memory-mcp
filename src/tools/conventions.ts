import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import type { MemoryType } from "../types/memory.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireWritePermission, getRepoTags, mergeRepoTags } from "./util.js";

export function registerConventionTools(server: McpServer, service: MemoryService) {
  // sync_conventions — parse structured doc into typed memories
  server.registerTool(
    "sync_conventions",
    {
      description:
        "Import conventions/rules from a CLAUDE.md, ARCHITECTURE.md, or similar doc. Parses sections into typed memories (conventions, decisions, procedures). Dedup prevents duplicates on re-sync.",
      inputSchema: {
        content: z.string().min(1).max(100000).describe("Full text content of the conventions document"),
        source: z.string().min(1).max(500).describe("Source file path (e.g., CLAUDE.md, ARCHITECTURE.md)"),
        team_slug: z.string().optional().describe("Team slug"),
      },
      annotations: {
        title: "Sync Conventions",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const repoTags = getRepoTags();
      const team_slug = params.team_slug ?? ctx.team_slug;

      const results = await service.syncConventions({
        content: params.content,
        source: params.source,
        tags: mergeRepoTags([`source:${params.source}`], repoTags),
        org_id: ctx.org_id,
        ...(team_slug !== undefined && { team_slug }),
        created_by: ctx.user_id,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              synced: results.length,
              memories: results.map((r) => ({
                id: r.id,
                memory_type: r.memory_type,
                summary: r.summary,
                dedup_action: r.dedup_action,
              })),
            }),
          },
        ],
      };
    }, "sync_conventions"),
  );

  // export_conventions — generate a CLAUDE.md-compatible block from stored conventions
  server.registerTool(
    "export_conventions",
    {
      description:
        "Export stored conventions and decisions as structured JSON, categorized by memory type. Useful for generating CLAUDE.md or similar.",
      inputSchema: {
        team_slug: z.string().optional().describe("Team slug"),
        include_types: z
          .array(z.enum(["convention", "decision", "procedure", "fact"]))
          .default(["convention", "decision", "procedure"])
          .describe("Memory types to include"),
      },
      annotations: {
        title: "Export Conventions",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;

      const includeTypes: MemoryType[] = params.include_types;
      const categorized: Record<string, { id: string; summary: string; content: string; tags: string[] }[]> = {};

      for (const memType of includeTypes) {
        const memories = await service.listMemories({
          memory_type: memType,
          team_slug,
          org_id: ctx.org_id,
          user_id: ctx.user_id,
          limit: 50,
          offset: 0,
        });

        if (memories.length === 0) continue;

        categorized[memType] = memories.map((m) => ({
          id: m.id,
          summary: m.summary,
          content: m.content,
          tags: m.tags,
        }));
      }

      const totalCount = Object.values(categorized).reduce((sum, arr) => sum + arr.length, 0);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              team_slug: team_slug ?? null,
              include_types: includeTypes,
              count: totalCount,
              categories: categorized,
            }),
          },
        ],
      };
    }, "export_conventions"),
  );
}

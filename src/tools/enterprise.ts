import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireAdminPermission } from "./util.js";

export function registerEnterpriseTools(server: McpServer, service: MemoryService) {
  // set_memory_policy — configure selective memory rules
  server.registerTool(
    "set_memory_policy",
    {
      description:
        "Configure what should be remembered and what should be filtered out. Defines per-team rules for selective memory.",
      inputSchema: {
        remember: z
          .string()
          .max(2000)
          .optional()
          .describe("What to remember (e.g., 'architectural decisions, deployment procedures, error resolutions')"),
        ignore: z
          .string()
          .max(2000)
          .optional()
          .describe("What to never store (e.g., 'temporary debug output, credentials, PII')"),
        categories: z
          .array(z.string())
          .max(20)
          .optional()
          .describe("Auto-tag categories (e.g., ['deployment', 'security', 'performance'])"),
        team_slug: z.string().optional().describe("Team slug"),
      },
      annotations: {
        title: "Set Memory Policy",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireAdminPermission();
      const ctx = getRequestContextOrDefault();

      const policy = await service.setMemoryPolicy(ctx.org_id, params.team_slug ?? ctx.team_slug, {
        ...(params.remember !== undefined && { remember: params.remember }),
        ...(params.ignore !== undefined && { ignore: params.ignore }),
        ...(params.categories !== undefined && {
          categories: params.categories,
        }),
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: policy.id,
              rules: policy.rules,
              message: "Memory policy updated. New memories will be evaluated against these rules.",
            }),
          },
        ],
      };
    }, "set_memory_policy"),
  );

  // query_entities — explore the knowledge graph
  server.registerTool(
    "query_entities",
    {
      description:
        "Search the knowledge graph for entities (services, files, packages, concepts) and their relationships. Use this to explore 'what do we know about X?'",
      inputSchema: {
        query: z.string().min(1).max(500).describe("Entity name or search term"),
        entity_type: z
          .enum(["service", "file", "package", "person", "concept", "api", "error", "env_var"])
          .optional()
          .describe("Filter by entity type"),
        include_relations: z.boolean().default(true).describe("Include entity relationships"),
        limit: z.number().min(1).max(50).default(10).describe("Max results"),
      },
      annotations: {
        title: "Query Entities",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireAdminPermission();
      const ctx = getRequestContextOrDefault();

      const result = await service.queryEntities({
        query: params.query,
        ...(params.entity_type !== undefined && {
          entityType: params.entity_type,
        }),
        includeRelations: params.include_relations,
        orgId: ctx.org_id,
        limit: params.limit,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
      };
    }, "query_entities"),
  );

  // detect_conflicts — find contradicting memories
  server.registerTool(
    "detect_conflicts",
    {
      description:
        "Scan for contradicting memories within a team. Returns pairs of memories that may conflict with each other.",
      inputSchema: {
        team_slug: z.string().optional().describe("Team slug"),
        memory_type: z
          .enum(["fact", "decision", "procedure", "episode", "reference", "convention"])
          .optional()
          .describe("Filter by memory type"),
        limit: z.number().min(1).max(20).default(5).describe("Max conflict pairs to return"),
      },
      annotations: {
        title: "Detect Conflicts",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireAdminPermission();
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;

      const conflicts = await service.detectConflicts({
        orgId: ctx.org_id,
        ...(team_slug !== undefined && { teamSlug: team_slug }),
        ...(params.memory_type !== undefined && {
          memoryType: params.memory_type,
        }),
        limit: params.limit,
      });

      if (conflicts.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                count: 0,
                conflicts: [],
                message: "No conflicting memories detected.",
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
              count: conflicts.length,
              conflicts: conflicts.map((c) => ({
                memory_a: {
                  id: c.a.id,
                  summary: c.a.summary,
                  memory_type: c.a.memory_type,
                  created_by: c.a.created_by,
                },
                memory_b: {
                  id: c.b.id,
                  summary: c.b.summary,
                  memory_type: c.b.memory_type,
                  created_by: c.b.created_by,
                },
                similarity: c.similarity,
                reason: c.reason,
              })),
              suggestion:
                "Use 'correct' to supersede the outdated memory, or 'link_memories' with 'contradicts' to flag both.",
            }),
          },
        ],
      };
    }, "detect_conflicts"),
  );

  // purge_memories — GDPR hard-delete
  server.registerTool(
    "purge_memories",
    {
      description:
        "Hard-delete memories by user ID (GDPR right-to-forget). Permanently removes content, embeddings, tags, relations, and anonymizes audit entries. THIS IS IRREVERSIBLE.",
      inputSchema: {
        user_id: z.string().min(1).describe("User ID whose memories to permanently delete"),
        confirm: z.literal(true).describe("Must be true to confirm irreversible deletion"),
      },
      annotations: {
        title: "Purge Memories (GDPR)",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireAdminPermission();
      const ctx = getRequestContextOrDefault();

      const result = await service.purgeUserMemories(params.user_id, ctx.org_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              purged: result.deleted,
              anonymized_audit_entries: result.anonymized,
              orphaned_entities_deleted: result.orphaned_entities_deleted,
              orphaned_relations_deleted: result.orphaned_relations_deleted,
              message: `Permanently deleted ${result.deleted} memories for user ${params.user_id}. Audit entries anonymized. Cleaned up ${result.orphaned_entities_deleted} orphaned entities and ${result.orphaned_relations_deleted} orphaned entity relations.`,
            }),
          },
        ],
      };
    }, "purge_memories"),
  );

  // reembed_memories — re-embed all memories with current provider
  server.registerTool(
    "reembed_memories",
    {
      description:
        "Re-embed active memories using the current embedding provider. Use after switching embedding models, or with null_only=true to backfill memories missing embeddings (e.g. after migration 010). Processes in batches. THIS MAY TAKE A WHILE for large datasets.",
      inputSchema: {
        batch_size: z.number().min(1).max(200).default(50).describe("Number of memories to process per batch"),
        null_only: z
          .boolean()
          .default(false)
          .describe(
            "If true, only re-embed memories with NULL embeddings (backfill mode). Useful after migration 010 destroyed embeddings.",
          ),
        confirm: z.literal(true).describe("Must be true to confirm re-embedding"),
      },
      annotations: {
        title: "Re-embed Memories",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireAdminPermission();
      const ctx = getRequestContextOrDefault();

      const result = await service.reembedMemories(ctx.org_id, params.batch_size, params.null_only);

      const modeLabel = params.null_only ? "backfilled" : "re-embedded";
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              processed: result.processed,
              failed: result.failed,
              total: result.total,
              null_only: params.null_only,
              message: `${modeLabel[0]?.toUpperCase()}${modeLabel.slice(1)} ${result.processed}/${result.total} memories. ${result.failed} failed.`,
            }),
          },
        ],
      };
    }, "reembed_memories"),
  );

  // get_memory_analytics — extended analytics
  server.registerTool(
    "get_memory_analytics",
    {
      description:
        "Get extended memory analytics: growth trends, retrieval patterns, agent contributions, and stale memory detection.",
      inputSchema: {
        team_slug: z.string().optional().describe("Team slug"),
        days: z.number().min(1).max(90).default(30).describe("Analysis window in days"),
      },
      annotations: {
        title: "Get Memory Analytics",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireAdminPermission();
      const ctx = getRequestContextOrDefault();
      const team_slug = params.team_slug ?? ctx.team_slug;

      const analytics = await service.getAnalytics(ctx.org_id, team_slug, params.days);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(analytics),
          },
        ],
      };
    }, "get_memory_analytics"),
  );
}

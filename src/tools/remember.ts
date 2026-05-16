import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { memoryTypes, memoryScopes, tagsArraySchema } from "../types/memory.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireWritePermission, getRepoTags, mergeRepoTags } from "./util.js";
import { ValidationError } from "../errors.js";

export function registerRememberTools(server: McpServer, service: MemoryService) {
  // remember — the primary write tool
  server.registerTool(
    "remember",
    {
      description:
        "Record a memory. Runs smart pipeline: generates summary, scores importance, checks for duplicates, and creates/merges/supersedes as needed.",
      inputSchema: {
        content: z.string().min(1).describe("The knowledge to remember (markdown)"),
        memory_type: z
          .enum(memoryTypes)
          .describe(
            "Type: fact (atomic truth), decision (choice + rationale), procedure (how-to), episode (past experience), reference (long-form doc), convention (team/org coding standards)",
          ),
        scope: z.enum(memoryScopes).default("team").describe("Visibility: personal, team, org, or public"),
        tags: tagsArraySchema.describe("Classification tags"),
        importance: z.number().min(0).max(1).optional().describe("Importance score 0-1 (auto-calculated if omitted)"),
        team_slug: z.string().optional().describe("Team slug (for team/org scope)"),
        external_id: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Stable external identifier for idempotent ingestion. If provided, upserts instead of creating duplicates.",
          ),
        source: z.string().optional().describe("Where this knowledge came from"),
        ttl_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe("Auto-expire after this many days (e.g. 7 for weekly, 90 for quarterly). Omit for permanent."),
        group_id: z
          .uuid()
          .optional()
          .describe(
            "Group UUID to associate this memory with an ordered sequence (e.g., document chunks, conversation thread)",
          ),
        sequence: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Position within the group (0-based). Required when group_id is set."),
        group_type: z
          .string()
          .max(50)
          .optional()
          .describe('Type of group (e.g., "document", "conversation", "thread", "procedure")'),
        local_only: z
          .boolean()
          .default(false)
          .describe("If true, this memory stays local and is never synced to cloud"),
      },
      annotations: {
        title: "Remember",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      if (params.scope === "personal" && !ctx.user_id) {
        throw new ValidationError("Personal scope requires an authenticated user (user_id is missing)");
      }
      const tags = mergeRepoTags(params.tags, getRepoTags());
      const team_slug = params.team_slug ?? ctx.team_slug;
      const result = await service.remember({
        ...params,
        tags,
        team_slug,
        org_id: ctx.org_id,
        user_id: params.scope === "personal" ? ctx.user_id : undefined,
        created_by: ctx.user_id,
        ttl_days: params.ttl_days,
        external_id: params.external_id,
        group_id: params.group_id,
        sequence: params.sequence,
        group_type: params.group_type,
        local_only: params.local_only,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              summary: result.summary,
              memory_type: result.memory_type,
              scope: result.scope,
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

  // remember_fact — shorthand for atomic facts
  server.registerTool(
    "remember_fact",
    {
      description:
        "Quick way to record an atomic fact. Auto-sets type to 'fact', checks for contradictions with existing facts.",
      inputSchema: {
        fact: z.string().min(1).describe("The atomic fact to remember"),
        tags: tagsArraySchema.describe("Classification tags"),
        scope: z.enum(memoryScopes).default("team").describe("Visibility scope"),
        team_slug: z.string().optional().describe("Team slug"),
        local_only: z
          .boolean()
          .default(false)
          .describe("If true, this memory stays local and is never synced to cloud"),
      },
      annotations: {
        title: "Remember Fact",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      if (params.scope === "personal" && !ctx.user_id) {
        throw new ValidationError("Personal scope requires an authenticated user (user_id is missing)");
      }
      const tags = mergeRepoTags(params.tags, getRepoTags());
      const team_slug = params.team_slug ?? ctx.team_slug;
      const result = await service.rememberFact({
        ...params,
        tags,
        team_slug,
        org_id: ctx.org_id,
        user_id: params.scope === "personal" ? ctx.user_id : undefined,
        created_by: ctx.user_id,
        local_only: params.local_only,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
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

  // remember_decision — structured ADR capture
  server.registerTool(
    "remember_decision",
    {
      description:
        "Record an architectural decision with structured context, rationale, and alternatives. Creates a formatted ADR.",
      inputSchema: {
        title: z.string().min(1).describe("Decision title"),
        context: z.string().min(1).describe("What issue or context prompted this decision?"),
        decision: z.string().min(1).describe("What was decided and why?"),
        rationale: z.string().min(1).describe("Detailed rationale for the decision"),
        alternatives: z.string().optional().describe("Alternatives that were considered"),
        tags: tagsArraySchema.describe("Classification tags"),
        scope: z.enum(memoryScopes).default("team").describe("Visibility scope (defaults to team)"),
        team_slug: z.string().optional().describe("Team slug"),
        local_only: z
          .boolean()
          .default(false)
          .describe("If true, this memory stays local and is never synced to cloud"),
      },
      annotations: {
        title: "Remember Decision",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      if (params.scope === "personal" && !ctx.user_id) {
        throw new ValidationError("Personal scope requires an authenticated user (user_id is missing)");
      }
      const tags = mergeRepoTags(params.tags, getRepoTags());
      const team_slug = params.team_slug ?? ctx.team_slug;
      const result = await service.rememberDecision({
        ...params,
        tags,
        team_slug,
        org_id: ctx.org_id,
        user_id: params.scope === "personal" ? ctx.user_id : undefined,
        created_by: ctx.user_id,
        local_only: params.local_only,
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              id: result.id,
              title: params.title,
              summary: result.summary,
              memory_type: result.memory_type,
              scope: result.scope,
              importance: result.importance,
              dedup_action: result.dedup_action,
              tags: result.tags,
            }),
          },
        ],
      };
    }, "remember_decision"),
  );
}

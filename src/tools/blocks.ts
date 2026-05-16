import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireWritePermission } from "./util.js";
import { ValidationError } from "../errors.js";

export function registerBlockTools(server: McpServer, service: MemoryService): void {
  // update_memory_block — create or update a named memory block
  server.registerTool(
    "update_memory_block",
    {
      description:
        "Create or update a persistent named memory block. Blocks are always-in-context text that persists across sessions — use for project context, conventions, current task state, or scratchpad notes. Operations: replace (default), append, prepend.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[a-z0-9_]+$/, "Block name must be lowercase alphanumeric with underscores only")
          .describe('Block name (e.g. "project_context", "conventions", "current_task", "scratchpad")'),
        content: z.string().min(1).max(50_000).describe("Content to write to the block"),
        operation: z
          .enum(["replace", "append", "prepend"])
          .default("replace")
          .describe("How to update: replace (overwrite), append (add to end), prepend (add to start)"),
        scope: z
          .enum(["team", "personal"])
          .default("team")
          .describe("Scope: team (shared with team) or personal (only you)"),
        max_tokens: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(500)
          .describe("Maximum token budget for this block (1-5000)"),
      },
      annotations: {
        title: "Update Memory Block",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();

      let teamId: string | null = null;
      const teamSlug = ctx.team_slug;
      if (params.scope === "team") {
        if (!teamSlug) {
          throw new ValidationError(
            "Team scope requires a team_slug (configure it in ~/.engram/config.json or set ENGRAM_TEAM)",
          );
        }
        teamId = await service.resolveTeamId(teamSlug, ctx.org_id);
      }

      const userId = params.scope === "personal" ? ctx.user_id : null;
      if (params.scope === "personal" && !userId) {
        throw new ValidationError("Personal scope requires an authenticated user (user_id is missing)");
      }

      const block = await service.updateMemoryBlock(
        params.name,
        params.content,
        params.operation,
        ctx.org_id,
        teamId,
        userId,
        params.max_tokens,
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: "updated",
              block: {
                name: block.name,
                scope: params.scope,
                content_length: block.content.length,
                max_tokens: block.max_tokens,
                updated_at: block.updated_at,
              },
            }),
          },
        ],
      };
    }, "update_memory_block"),
  );

  // get_memory_blocks — list all blocks with their content
  server.registerTool(
    "get_memory_blocks",
    {
      description:
        "List all memory blocks with their content. Memory blocks are persistent named text that survives across sessions — use to read project context, conventions, or task state.",
      inputSchema: {
        scope: z
          .enum(["team", "personal", "all"])
          .default("all")
          .describe("Which blocks to return: team (shared), personal (yours only), all (both)"),
      },
      annotations: {
        title: "Get Memory Blocks",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      const ctx = getRequestContextOrDefault();
      const teamSlug = ctx.team_slug;

      const blocks: {
        name: string;
        scope: string;
        content: string;
        max_tokens: number;
        updated_at: Date;
      }[] = [];

      if (params.scope === "team" || params.scope === "all") {
        if (teamSlug) {
          const resolvedTeamId = await service.resolveTeamId(teamSlug, ctx.org_id);
          const teamBlocks = await service.listMemoryBlocks(ctx.org_id, resolvedTeamId, null);
          blocks.push(
            ...teamBlocks.map((b) => ({
              name: b.name,
              scope: "team" as const,
              content: b.content,
              max_tokens: b.max_tokens,
              updated_at: b.updated_at,
            })),
          );
        }
      }

      if (params.scope === "personal" || params.scope === "all") {
        if (ctx.user_id) {
          const personalBlocks = await service.listMemoryBlocks(ctx.org_id, null, ctx.user_id);
          blocks.push(
            ...personalBlocks.map((b) => ({
              name: b.name,
              scope: "personal" as const,
              content: b.content,
              max_tokens: b.max_tokens,
              updated_at: b.updated_at,
            })),
          );
        }
      }

      if (blocks.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "No memory blocks found. Use update_memory_block to create one.",
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              count: blocks.length,
              blocks,
            }),
          },
        ],
      };
    }, "get_memory_blocks"),
  );

  // delete_memory_block — remove a named block
  server.registerTool(
    "delete_memory_block",
    {
      description: "Delete a persistent memory block by name.",
      inputSchema: {
        name: z.string().min(1).max(100).describe("Block name to delete"),
        scope: z.enum(["team", "personal"]).default("team").describe("Scope of the block to delete"),
      },
      annotations: {
        title: "Delete Memory Block",
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();

      let teamId: string | null = null;
      const teamSlug = ctx.team_slug;
      if (params.scope === "team") {
        if (!teamSlug) {
          throw new ValidationError("Team scope requires a team_slug");
        }
        teamId = await service.resolveTeamId(teamSlug, ctx.org_id);
      }

      const userId = params.scope === "personal" ? ctx.user_id : null;
      if (params.scope === "personal" && !userId) {
        throw new ValidationError("Personal scope requires an authenticated user");
      }

      const deleted = await service.deleteMemoryBlock(params.name, ctx.org_id, teamId, userId);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              status: deleted ? "deleted" : "not_found",
              name: params.name,
              scope: params.scope,
            }),
          },
        ],
      };
    }, "delete_memory_block"),
  );
}

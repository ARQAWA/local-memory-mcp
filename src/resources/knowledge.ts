import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "../services/memory.service.js";
import { getRequestContextOrDefault } from "../context.js";
import { logger } from "../services/logger.js";

/**
 * Wrap a resource handler with error handling.
 * Returns a JSON error response instead of crashing the MCP server.
 */
function withResourceErrorHandling<T extends unknown[]>(
  name: string,
  handler: (...args: T) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }>,
): (...args: T) => Promise<{ contents: { uri: string; mimeType: string; text: string }[] }> {
  return async (...args: T) => {
    try {
      return await handler(...args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Resource error: ${name}`, { error: message });
      return {
        contents: [
          {
            uri: `memory://error/${name}`,
            mimeType: "application/json",
            text: JSON.stringify({ error: `Failed to load resource: ${name}` }),
          },
        ],
      };
    }
  };
}

export function registerMemoryResources(server: McpServer, service: MemoryService) {
  // List all teams (static URI)
  server.registerResource(
    "teams-list",
    "memory://teams",
    {
      description: "List all teams in the memory base",
      mimeType: "application/json",
    },
    withResourceErrorHandling("teams-list", async () => {
      const ctx = getRequestContextOrDefault();
      const teams = await service.listTeams(ctx.org_id);
      return {
        contents: [
          {
            uri: "memory://teams",
            mimeType: "application/json",
            text: JSON.stringify(teams),
          },
        ],
      };
    }),
  );

  // Team details (template)
  server.registerResource(
    "team-detail",
    new ResourceTemplate("memory://team/{slug}", { list: undefined }),
    {
      description: "Team details with memory summary and types breakdown",
      mimeType: "application/json",
    },
    withResourceErrorHandling("team-detail", async (uri: URL, variables: Record<string, string | string[]>) => {
      const slugRaw = variables["slug"];
      const slug = Array.isArray(slugRaw) ? (slugRaw[0] ?? "") : (slugRaw ?? "");
      const ctx = getRequestContextOrDefault();
      const summary = await service.getTeamOverview(slug, ctx.org_id);
      if (!summary) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Team not found" }),
            },
          ],
        };
      }
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(summary),
          },
        ],
      };
    }),
  );

  // Single memory detail (template)
  server.registerResource(
    "memory-detail",
    new ResourceTemplate("memory://memory/{id}", { list: undefined }),
    {
      description: "Full memory with content and relations",
      mimeType: "application/json",
    },
    withResourceErrorHandling("memory-detail", async (uri: URL, variables: Record<string, string | string[]>) => {
      const idRaw = variables["id"];
      const id = Array.isArray(idRaw) ? (idRaw[0] ?? "") : (idRaw ?? "");
      const ctx = getRequestContextOrDefault();
      const memory = await service.getMemory(id, ctx.org_id);
      if (!memory) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({ error: "Memory not found" }),
            },
          ],
        };
      }
      const relations = await service.getRelated(id, ctx.org_id);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ ...memory, relations }),
          },
        ],
      };
    }),
  );

  // All tags (static URI)
  server.registerResource(
    "tags-list",
    "memory://tags",
    {
      description: "All tags with memory counts",
      mimeType: "application/json",
    },
    withResourceErrorHandling("tags-list", async () => {
      const ctx = getRequestContextOrDefault();
      const tags = await service.getAllTags(ctx.org_id);
      return {
        contents: [
          {
            uri: "memory://tags",
            mimeType: "application/json",
            text: JSON.stringify(tags),
          },
        ],
      };
    }),
  );

  // Memory base stats (static URI)
  server.registerResource(
    "memory-stats",
    "memory://stats",
    {
      description: "Memory base statistics — totals by type, scope, tags",
      mimeType: "application/json",
    },
    withResourceErrorHandling("memory-stats", async () => {
      const ctx = getRequestContextOrDefault();
      const stats = await service.getMemoryStats(ctx.org_id);
      return {
        contents: [
          {
            uri: "memory://stats",
            mimeType: "application/json",
            text: JSON.stringify(stats),
          },
        ],
      };
    }),
  );

  // List memories by type with pagination
  server.registerResource(
    "memories-by-type",
    new ResourceTemplate("memory://type/{type}", { list: undefined }),
    {
      description:
        "List memories by type with pagination (supports ?limit=N&offset=M query params, default limit=50, max=200)",
      mimeType: "application/json",
    },
    withResourceErrorHandling("memories-by-type", async (uri: URL, variables: Record<string, string | string[]>) => {
      const typeRaw = variables["type"];
      const memoryType = Array.isArray(typeRaw) ? (typeRaw[0] ?? "") : (typeRaw ?? "");

      // Parse pagination params from query string
      const limitParam = uri.searchParams.get("limit");
      const offsetParam = uri.searchParams.get("offset");
      const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 200) : 50;
      const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;

      const ctx = getRequestContextOrDefault();

      // Validate memory type
      const validTypes = ["fact", "decision", "procedure", "episode", "reference", "convention"];
      if (!validTypes.includes(memoryType)) {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify({
                error: `Invalid memory type. Must be one of: ${validTypes.join(", ")}`,
              }),
            },
          ],
        };
      }

      const memories = await service.listMemories({
        memory_type: memoryType as "fact" | "decision" | "procedure" | "episode" | "reference" | "convention",
        org_id: ctx.org_id,
        limit,
        offset,
      });

      // Calculate pagination metadata
      const hasMore = memories.length === limit;
      const nextOffset = hasMore ? offset + limit : null;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              memories,
              pagination: {
                limit,
                offset,
                count: memories.length,
                has_more: hasMore,
                next_offset: nextOffset,
              },
            }),
          },
        ],
      };
    }),
  );

  // List memories by tag with pagination
  server.registerResource(
    "memories-by-tag",
    new ResourceTemplate("memory://tag/{tag}", { list: undefined }),
    {
      description:
        "List memories by tag with pagination (supports ?limit=N&offset=M query params, default limit=50, max=200)",
      mimeType: "application/json",
    },
    withResourceErrorHandling("memories-by-tag", async (uri: URL, variables: Record<string, string | string[]>) => {
      const tagRaw = variables["tag"];
      const tag = Array.isArray(tagRaw) ? (tagRaw[0] ?? "") : (tagRaw ?? "");

      // Parse pagination params from query string
      const limitParam = uri.searchParams.get("limit");
      const offsetParam = uri.searchParams.get("offset");
      const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 200) : 50;
      const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;

      const ctx = getRequestContextOrDefault();

      const memories = await service.listMemories({
        tags: [tag],
        org_id: ctx.org_id,
        limit,
        offset,
      });

      // Calculate pagination metadata
      const hasMore = memories.length === limit;
      const nextOffset = hasMore ? offset + limit : null;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              memories,
              pagination: {
                limit,
                offset,
                count: memories.length,
                has_more: hasMore,
                next_offset: nextOffset,
              },
            }),
          },
        ],
      };
    }),
  );

  // List memories by team with pagination
  server.registerResource(
    "memories-by-team",
    new ResourceTemplate("memory://team/{slug}/memories", { list: undefined }),
    {
      description:
        "List memories by team with pagination (supports ?limit=N&offset=M query params, default limit=50, max=200)",
      mimeType: "application/json",
    },
    withResourceErrorHandling("memories-by-team", async (uri: URL, variables: Record<string, string | string[]>) => {
      const slugRaw = variables["slug"];
      const slug = Array.isArray(slugRaw) ? (slugRaw[0] ?? "") : (slugRaw ?? "");

      // Parse pagination params from query string
      const limitParam = uri.searchParams.get("limit");
      const offsetParam = uri.searchParams.get("offset");
      const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 200) : 50;
      const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;

      const ctx = getRequestContextOrDefault();

      const memories = await service.listMemories({
        team_slug: slug,
        org_id: ctx.org_id,
        limit,
        offset,
      });

      // Calculate pagination metadata
      const hasMore = memories.length === limit;
      const nextOffset = hasMore ? offset + limit : null;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              memories,
              pagination: {
                limit,
                offset,
                count: memories.length,
                has_more: hasMore,
                next_offset: nextOffset,
              },
            }),
          },
        ],
      };
    }),
  );

  // List all memories with pagination
  server.registerResource(
    "memories-list",
    "memory://memories",
    {
      description:
        "List all memories with pagination (supports ?limit=N&offset=M query params, default limit=50, max=200)",
      mimeType: "application/json",
    },
    withResourceErrorHandling("memories-list", async (uri: URL) => {
      // Parse pagination params from query string
      const limitParam = uri.searchParams.get("limit");
      const offsetParam = uri.searchParams.get("offset");
      const limit = limitParam ? Math.min(Math.max(1, parseInt(limitParam, 10)), 200) : 50;
      const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10)) : 0;

      const ctx = getRequestContextOrDefault();

      const memories = await service.listMemories({
        org_id: ctx.org_id,
        limit,
        offset,
      });

      // Calculate pagination metadata
      const hasMore = memories.length === limit;
      const nextOffset = hasMore ? offset + limit : null;

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({
              memories,
              pagination: {
                limit,
                offset,
                count: memories.length,
                has_more: hasMore,
                next_offset: nextOffset,
              },
            }),
          },
        ],
      };
    }),
  );
}

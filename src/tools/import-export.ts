import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { getRequestContextOrDefault } from "../context.js";
import { withErrorHandling, requireWritePermission } from "./util.js";

export function registerImportExportTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "import_markdown",
    {
      description:
        "Bulk import memories from structured markdown. Each H2 heading becomes a separate memory. Tags are extracted from **Tags:** lines.",
      inputSchema: {
        team_slug: z.string().min(1).optional().describe("Team slug to import into (defaults to current team)"),
        markdown: z.string().min(1).describe("Structured markdown content with H2 sections"),
      },
      annotations: {
        title: "Import Markdown",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    withErrorHandling(async ({ team_slug, markdown }) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const resolvedTeamSlug = team_slug ?? ctx.team_slug ?? "default";
      const result = await service.importMarkdown(resolvedTeamSlug, markdown, ctx.user_id, ctx.org_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result),
          },
        ],
        isError: result.imported === 0 && result.errors.length > 0,
      };
    }, "import_markdown"),
  );

  server.registerTool(
    "export_markdown",
    {
      description: "Export memories as structured markdown, grouped by type. Useful for Git workflows and PR review.",
      inputSchema: {
        team_slug: z.string().min(1).optional().describe("Team slug to export (defaults to current team)"),
      },
      annotations: {
        title: "Export Markdown",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    withErrorHandling(async ({ team_slug }) => {
      const ctx = getRequestContextOrDefault();
      const resolvedTeamSlug = team_slug ?? ctx.team_slug ?? "default";
      const markdown = await service.exportMarkdown(resolvedTeamSlug, ctx.org_id, ctx.user_id);
      return {
        content: [
          {
            type: "text" as const,
            text: markdown,
          },
        ],
      };
    }, "export_markdown"),
  );
}

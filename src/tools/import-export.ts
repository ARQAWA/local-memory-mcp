import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContextOrDefault } from "../context.js";
import { MemoryService } from "../services/memory.service.js";
import { repositoryReadModes } from "../types/memory.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

const repositorySelector = {
  repository_mode: z.enum(repositoryReadModes).default("current"),
  repository: z.string().optional(),
};

export function registerImportExportTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "import_markdown",
    {
      description: "Bulk import markdown sections into the current repository.",
      inputSchema: { markdown: z.string().min(1) },
      annotations: { title: "Import Markdown", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async ({ markdown }) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const result = await service.importMarkdown(markdown, ctx.user_id);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "import_markdown"),
  );

  server.registerTool(
    "export_markdown",
    {
      description: "Export repository memories as markdown.",
      inputSchema: { ...repositorySelector },
      annotations: { title: "Export Markdown", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const markdown = await service.exportMarkdown(params);
      return { content: [{ type: "text" as const, text: markdown }] };
    }, "export_markdown"),
  );
}

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { repositoryReadModes } from "../types/memory.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

const repositorySelector = {
  repository_mode: z.enum(repositoryReadModes).default("current"),
  repository: z.string().optional(),
};

export function registerConventionTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "sync_conventions",
    {
      description: "Import conventions from a local repository document.",
      inputSchema: { content: z.string().min(1), source: z.string().min(1), tags: z.array(z.string()).default([]) },
      annotations: { title: "Sync Conventions", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const result = await service.syncConventions(params);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    }, "sync_conventions"),
  );

  server.registerTool(
    "export_conventions",
    {
      description: "Export repository conventions as markdown.",
      inputSchema: { ...repositorySelector },
      annotations: { title: "Export Conventions", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async (params) => {
      const markdown = await service.exportConventions(params);
      return { content: [{ type: "text" as const, text: markdown }] };
    }, "export_conventions"),
  );
}

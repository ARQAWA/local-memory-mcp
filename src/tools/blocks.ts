import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { MemoryService } from "../services/memory.service.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

export function registerBlockTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "update_memory_block",
    {
      description: "Create or update a persistent named block in the current repository.",
      inputSchema: {
        name: z.string().min(1).max(100),
        content: z.string(),
        max_tokens: z.number().min(1).max(5000).default(500),
        operation: z.enum(["replace", "append", "prepend"]).default("replace"),
      },
      annotations: { title: "Update Memory Block", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const block = await service.updateMemoryBlock(params.name, params.content, params.max_tokens, params.operation);
      return { content: [{ type: "text" as const, text: JSON.stringify(block) }] };
    }, "update_memory_block"),
  );

  server.registerTool(
    "get_memory_blocks",
    {
      description: "List persistent memory blocks for the current repository.",
      inputSchema: {},
      annotations: { title: "Get Memory Blocks", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async () => {
      const blocks = await service.listMemoryBlocks();
      return { content: [{ type: "text" as const, text: JSON.stringify({ blocks }) }] };
    }, "get_memory_blocks"),
  );

  server.registerTool(
    "delete_memory_block",
    {
      description: "Delete a persistent memory block from the current repository.",
      inputSchema: { name: z.string().min(1).max(100) },
      annotations: { title: "Delete Memory Block", readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    withErrorHandling(async ({ name }) => {
      requireWritePermission();
      const deleted = await service.deleteMemoryBlock(name);
      return { content: [{ type: "text" as const, text: JSON.stringify({ deleted }) }], isError: !deleted };
    }, "delete_memory_block"),
  );
}

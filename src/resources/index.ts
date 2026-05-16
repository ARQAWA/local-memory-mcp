import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "../services/memory.service.js";
import { registerMemoryResources } from "./knowledge.js";

export function registerAllResources(server: McpServer, service: MemoryService) {
  registerMemoryResources(server, service);
}

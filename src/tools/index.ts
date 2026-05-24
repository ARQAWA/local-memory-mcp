import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "../services/memory.service.js";
import { registerProjectMemoryTools } from "./project-memory.js";

export function registerAllTools(server: McpServer, service: MemoryService) {
  registerProjectMemoryTools(server, service);
}

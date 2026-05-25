import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectMemoryBackend } from "./project-memory-backend.js";
import { registerProjectMemoryTools } from "./project-memory.js";

export function registerAllTools(server: McpServer, service: ProjectMemoryBackend) {
  registerProjectMemoryTools(server, service);
}

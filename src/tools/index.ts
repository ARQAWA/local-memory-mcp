import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "../services/memory.service.js";
import { registerRecallTools } from "./recall.js";
import { registerRememberTools } from "./remember.js";
import { registerManageTools } from "./manage.js";
import { registerImportExportTools } from "./import-export.js";
import { registerCodingTools } from "./coding.js";
import { registerSessionTools } from "./session.js";
import { registerConventionTools } from "./conventions.js";
import { registerDebuggingTools } from "./debugging.js";
import { registerEnterpriseTools } from "./enterprise.js";
import { registerBlockTools } from "./blocks.js";

export function registerAllTools(server: McpServer, service: MemoryService) {
  registerRecallTools(server, service);
  registerRememberTools(server, service);
  registerManageTools(server, service);
  registerImportExportTools(server, service);
  registerCodingTools(server, service);
  registerSessionTools(server, service);
  registerConventionTools(server, service);
  registerDebuggingTools(server, service);
  registerEnterpriseTools(server, service);
  registerBlockTools(server, service);
}

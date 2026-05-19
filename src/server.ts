import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "./services/memory.service.js";
import { SamplingService } from "./services/sampling.service.js";
import { registerAllTools } from "./tools/index.js";
import { registerAllResources } from "./resources/index.js";
import { registerAllPrompts } from "./prompts/index.js";

export interface McpServerWithSampling {
  mcpServer: McpServer;
  samplingService: SamplingService;
}

const SERVER_INSTRUCTIONS = `You have access to Local Memory MCP, a local persistent memory system.

Memory is global on this host but partitioned by repository. Normal reads and writes use the current project, which can be a Git repository or a plain local folder.

Search another repository only when the user explicitly asks for it. Then use repository_mode=specific with a repository slug, or repository_mode=all for a deliberate cross-repository search.

Session start: call get_active_context. Before non-trivial work, call recall or get_context_for. Record durable facts with remember, remember_fact, or remember_decision. Correct stale memory with correct, and remove irrelevant memory with forget.

Use graph tools only for strong durable relationships. Create manual edges with link_memories only when both memory IDs are in the current repository and the relation is explicit, useful, and stronger than shared tags or shared entities. Use get_related for drill-down. Use query_entities for file/API/package/error/env discovery. Full graph context is for explicit graph, lineage, dependency, alternative, conflict, history, or broad related-context requests.

Use list_repositories to discover known repositories. Use get_repository_overview and get_memory_stats for repository health.`;

export function createMcpServer(service: MemoryService, version = "3.5.0"): McpServerWithSampling {
  const server = new McpServer(
    {
      name: "local-memory-mcp",
      version,
    },
    {
      instructions: SERVER_INSTRUCTIONS,
    },
  );

  // Create a per-session SamplingService bound to this McpServer's Server instance.
  // The caller is responsible for setting it in samplingContext (AsyncLocalStorage)
  // so that services can access it without shared mutable state.
  const samplingService = new SamplingService(server.server);

  registerAllTools(server, service);
  registerAllResources(server, service);
  registerAllPrompts(server);

  return { mcpServer: server, samplingService };
}

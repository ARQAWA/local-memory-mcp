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

const SERVER_INSTRUCTIONS = `Local Memory MCP is the agent core, a local persistent memory system.

Memory is global on this host but partitioned by repository. Normal reads and writes use the current project, which can be a Git repository or a plain local folder.

Before any task, call get_active_context. Before analysis, planning, editing, review, or repository-grounded answering, call recall or get_context_for with the current topic. If memory tools are missing or unavailable, stop unless the direct task is to install, configure, or repair Local Memory MCP itself.

For any task that needs discovery, planning, edits, tests, review, or more than one meaningful step, open a Task Working Memory scratch block with open_task_memory after initial recall. Keep it updated with update_task_memory while you discover code by layers, analyze, design, reject options, implement, test, review, and track risks. Use layered discovery for routes/endpoints, services, repositories, clients, permissions/auth, configs, tests, data contracts, docs, active install, and runtime when relevant. Before reporting done, close it with close_task_memory: delete scratch by default, keep one TTL task artifact, and promote durable knowledge only when it is reusable.

Search another repository only when the user explicitly asks for it. Then use repository_mode=specific with a repository slug, or repository_mode=all for a deliberate cross-repository search.

Record durable findings during work with remember, remember_fact, or remember_decision. For broad audits, refactors, migrations, removals, agent-instruction changes, or architecture research, maintain a coverage map in memory: goal, acceptance criteria, aliases, searched commands, checked files or zones, positive findings, negative findings, remaining risks, and proof. Before reporting done, run the Memory-Controlled Completion Protocol: close the requirements matrix, run positive checks, negative loophole checks, conflict checks, runtime or active-install proof when relevant, and a red-team pass that asks how the work could still be incomplete. Correct stale memory with correct. Remove irrelevant memory with forget or batch_forget. When a Task Working Memory workbench is open, close it with close_task_memory; use digest_session only for separate session-level consolidation.

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

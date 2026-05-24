import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "./services/memory.service.js";
import { SamplingService } from "./services/sampling.service.js";
import { registerAllTools } from "./tools/index.js";

export interface McpServerWithSampling {
  mcpServer: McpServer;
  samplingService: SamplingService;
}

const SERVER_INSTRUCTIONS = `Local Memory MCP is the agent core, a local persistent memory system.

Memory is global on this host but partitioned by repository. Normal reads and writes use the current project, which can be a Git repository or a plain local folder.

Before non-trivial analysis, planning, editing, review, or repository-grounded answering, call prepare_context(auto) with the current task. Use prepare_context(light) for micro-details and narrow follow-up facts. Work from the returned context_pack; do not read raw memory records.

At the end of a task, call commit_task with only reusable durable decisions, constraints, processes, gotchas, and roadmap items. Empty fields are ignored. Correct stale, wrong, deprecated, superseded, or uncertain cards with correct_memory.

Do not store secrets, tokens, passwords, private keys, credentials, or private auth material. Do not store agent guesses as current truth; use candidate or needs_review through commit_task metadata only when the uncertainty is useful.

Project memory cards use card_type and status. Status is more important than score: wrong cards are dropped; deprecated and superseded cards appear only in the Legacy section; candidate and needs_review are not current truth.

Public tools are intentionally limited to prepare_context, commit_task, and correct_memory. Retrieval requires the local Jina MLX reranker; memory is not operational without it.`;

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

  return { mcpServer: server, samplingService };
}

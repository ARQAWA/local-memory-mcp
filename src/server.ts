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

const SERVER_INSTRUCTIONS = `You have access to Local Memory MCP, a local persistent memory system for your AI agents.

**Session start:** Call get_active_context to load relevant team knowledge, conventions, and recent activity. Use set_session_context to declare what you're working on so memories get proper context.

**Before making changes:** Call recall with a description of what you're working on. Use get_context_for to get knowledge about a specific topic, file, or service. Use batch_recall to check multiple topics in parallel.

**Record knowledge:** Use remember for general memories, remember_fact for verified facts, remember_decision for architectural/design decisions. Always include context about WHY, not just what. Tag memories with relevant topics.

**Correct & manage:** Use correct to update outdated information (creates supersedes chain — never just overwrite). Use forget to remove irrelevant memories. Use link_memories to connect related knowledge. Use consolidate to merge fragmented memories on a topic.

**Search & explore:** Use search_memories for filtered queries (by type, tags, scope). Use list_memories to browse recent memories. Use get_memory to read a specific memory. Use get_related to explore connected knowledge. Use get_memory_stats for usage overview. Use get_team_overview for team knowledge summary.

**Debug patterns:** Use get_similar_errors when encountering errors to check known solutions. Use log_resolution after fixing bugs. Use log_learning to record technical insights.

**Conventions:** Use sync_conventions to load team coding conventions into context. Use export_conventions to extract conventions from memories into a shareable format.

**Import/Export:** Use import_markdown to bulk-load knowledge from markdown files. Use export_markdown to export memories for sharing or backup.

**Session end:** Call digest_session to summarize key learnings from this session for the team.

**Admin tools** (require admin role): set_memory_policy, query_entities, detect_conflicts, purge_memories, get_memory_analytics, reembed_memories.`;

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

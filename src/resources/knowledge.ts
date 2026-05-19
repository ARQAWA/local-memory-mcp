import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "../services/memory.service.js";

export function registerMemoryResources(server: McpServer, service: MemoryService) {
  server.registerResource(
    "repositories-list",
    "memory://repositories",
    {
      title: "Repositories",
      description: "Repositories known to the local memory database",
      mimeType: "application/json",
    },
    async (uri) => {
      const repositories = await service.listRepositories();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(repositories) }] };
    },
  );

  server.registerResource(
    "memory-detail",
    new ResourceTemplate("memory://memory/{id}", { list: undefined }),
    {
      title: "Memory",
      description: "Full memory with content and relations",
      mimeType: "application/json",
    },
    async (uri, variables) => {
      const id = Array.isArray(variables["id"]) ? variables["id"][0] : variables["id"];
      if (!id) return { contents: [{ uri: uri.href, mimeType: "application/json", text: "{}" }] };
      const repository = await service.currentRepository();
      const memory = await service.getMemory(id, repository.id, { includeInvalidated: true });
      const relations = memory ? await service.getRelated(id, repository.id, { mode: "lineage" }) : [];
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ memory, relations }),
          },
        ],
      };
    },
  );

  server.registerResource(
    "memory-tags",
    "memory://tags",
    {
      title: "Tags",
      description: "Tags with memory counts for the current repository",
      mimeType: "application/json",
    },
    async (uri) => {
      const tags = await service.getAllTags();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(tags) }] };
    },
  );

  server.registerResource(
    "memory-stats",
    "memory://stats",
    {
      title: "Stats",
      description: "Memory statistics by repository and type",
      mimeType: "application/json",
    },
    async (uri) => {
      const stats = await service.getMemoryStats();
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(stats) }] };
    },
  );
}

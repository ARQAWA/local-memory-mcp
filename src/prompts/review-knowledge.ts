import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerReviewKnowledgePrompt(server: McpServer) {
  server.registerPrompt(
    "review-knowledge",
    {
      description:
        "Review stale memories (>90 days since last access) for a team and suggest which to update, archive, or keep",
      argsSchema: {
        team_slug: z.string().describe("Team slug to review"),
      },
    },
    ({ team_slug }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please review stale memories for team "${team_slug}":

1. Use get_memory_stats with team_slug="${team_slug}" to see overall health.
2. Use list_memories with team_slug="${team_slug}" to get all active memories.
3. Identify memories that haven't been accessed in over 90 days.
4. For each stale memory, categorize it as:
   - **Update needed**: Content is likely outdated and should be refreshed
   - **Forget candidate**: Content may no longer be relevant (use forget tool)
   - **Still valid**: Content is evergreen and doesn't need changes

Present a summary table with:
- Memory summary and type
- Last accessed date
- Days since last access
- Your recommendation (update/forget/valid)
- Brief reason for recommendation

Then suggest a plan of action for the team.`,
            },
          },
        ],
      };
    },
  );
}

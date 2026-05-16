import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerFindExpertPrompt(server: McpServer) {
  server.registerPrompt(
    "find-expert",
    {
      description: "Find who knows about a topic by searching memories and their authors across teams",
      argsSchema: {
        topic: z.string().describe("Topic to find an expert for"),
        team_slug: z.string().optional().describe("Optional: limit to a specific team"),
      },
    },
    ({ topic, team_slug }) => {
      const teamScope = team_slug ? `and team_slug="${team_slug}"` : "";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `I need to find someone who knows about "${topic}". Please help:

1. Use recall with query="${topic}" ${teamScope} to find relevant memories.
2. Look at who created the top results — they are likely subject matter experts.
3. Also use search_memories with query="${topic} contact" to find contact information.

Present a summary:
- **Top experts**: People who created the most memories about this topic
- **Key memories**: The most relevant knowledge found
- **Suggested contacts**: Who to reach out to for questions about "${topic}"`,
            },
          },
        ],
      };
    },
  );
}

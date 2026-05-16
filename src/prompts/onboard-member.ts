import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerOnboardMemberPrompt(server: McpServer) {
  server.registerPrompt(
    "onboard-member",
    {
      description:
        "Team onboarding workflow — pulls team context, key memories, and relevant knowledge to help a new member get started",
      argsSchema: {
        team_slug: z.string().describe("Team slug to onboard into"),
        member_name: z.string().describe("Name of the new team member"),
      },
    },
    ({ team_slug, member_name }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `I'm onboarding ${member_name} to the "${team_slug}" team. Please help by:

1. Use the recall tool with query="conventions and standards" and team_slug="${team_slug}" to find team coding and process standards.
2. Use the recall tool with query="processes and workflows" and team_slug="${team_slug}" to find workflows.
3. Use the recall tool with query="key contacts and people" and team_slug="${team_slug}" to find key people.
4. Use the list_memories tool with team_slug="${team_slug}" and memory_type="fact" to find team-specific facts.
5. Use the search_memories tool with query="onboarding" and team_slug="${team_slug}" for onboarding-specific content.

Then compile a friendly onboarding summary for ${member_name} that covers:
- Team conventions and standards
- Key processes and workflows
- Important contacts
- Relevant facts and terminology
- Any onboarding-specific content`,
            },
          },
        ],
      };
    },
  );
}

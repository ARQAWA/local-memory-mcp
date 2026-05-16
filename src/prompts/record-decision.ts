import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerRecordDecisionPrompt(server: McpServer) {
  server.registerPrompt(
    "record-decision",
    {
      description:
        "Guided Architecture Decision Record (ADR) capture — walks through context, options considered, decision made, and consequences",
      argsSchema: {
        team_slug: z.string().describe("Team slug"),
        title: z.string().describe("Decision title"),
        context: z.string().describe("What is the issue or context for this decision?"),
        decision: z.string().describe("What was decided and why?"),
        rationale: z.string().describe("Detailed rationale for the decision"),
        alternatives: z.string().optional().describe("Alternatives that were considered"),
      },
    },
    ({ team_slug, title, context, decision, rationale, alternatives }) => {
      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please record this architecture decision using the remember_decision tool:

- team_slug: "${team_slug}"
- title: "${title}"
- context: "${context}"
- decision: "${decision}"
- rationale: "${rationale}"
${alternatives ? `- alternatives: "${alternatives}"` : ""}
- tags: adr, architecture
- scope: org

This will create a structured ADR memory visible org-wide.`,
            },
          },
        ],
      };
    },
  );
}

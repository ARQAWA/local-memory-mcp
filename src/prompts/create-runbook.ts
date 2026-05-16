import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

export function registerCreateRunbookPrompt(server: McpServer) {
  server.registerPrompt(
    "create-runbook",
    {
      description:
        "Guided runbook creation — walks through trigger conditions, diagnostic steps, resolution steps, escalation path, and rollback procedures",
      argsSchema: {
        team_slug: z.string().describe("Team slug"),
        title: z.string().describe("Runbook title (e.g. 'High Memory Usage on API Pods')"),
        trigger: z.string().describe("What triggers this runbook? (alert, symptom, etc.)"),
        steps: z.string().describe("Resolution steps (one per line)"),
        escalation: z.string().describe("Escalation path if steps don't resolve the issue"),
        rollback: z.string().optional().describe("Rollback steps if the fix causes problems"),
      },
    },
    ({ team_slug, title, trigger, steps, escalation, rollback }) => {
      const stepsList = steps
        .split("\n")
        .filter(Boolean)
        .map((s, i) => `${i + 1}. ${s.trim()}`)
        .join("\n");

      const content = `# Runbook: ${title}

## Trigger
${trigger}

## Resolution Steps
${stepsList}

## Escalation
${escalation}

${rollback ? `## Rollback\n${rollback}\n` : ""}
## Last Updated
${new Date().toISOString().split("T")[0]}`;

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Please record this runbook using the remember tool:

- content: the runbook content below
- memory_type: procedure
- scope: team
- team_slug: "${team_slug}"
- tags: runbook, operations

${content}`,
            },
          },
        ],
      };
    },
  );
}

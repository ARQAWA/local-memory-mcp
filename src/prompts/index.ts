import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerRecordDecisionPrompt } from "./record-decision.js";
import { registerCreateRunbookPrompt } from "./create-runbook.js";
import { registerOnboardMemberPrompt } from "./onboard-member.js";
import { registerReviewKnowledgePrompt } from "./review-knowledge.js";
import { registerFindExpertPrompt } from "./find-expert.js";

export function registerAllPrompts(server: McpServer) {
  registerRecordDecisionPrompt(server);
  registerCreateRunbookPrompt(server);
  registerOnboardMemberPrompt(server);
  registerReviewKnowledgePrompt(server);
  registerFindExpertPrompt(server);
}

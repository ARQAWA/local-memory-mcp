import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getRequestContextOrDefault } from "../context.js";
import { ValidationError } from "../errors.js";
import { MemoryService } from "../services/memory.service.js";
import { requireWritePermission, withErrorHandling } from "./util.js";

const sectionTitles = {
  acceptance_criteria: "Acceptance Criteria",
  discovery_map: "Discovery Map",
  analysis: "Analysis",
  design_plan: "Design Plan",
  rejected_options: "Rejected Options",
  layer_implementation_plan: "Layer Implementation Plan",
  progress: "Progress",
  test_matrix: "Test Matrix",
  review_checklist: "Review Checklist",
  risks: "Risks",
  durable_extract: "Durable Extract",
  notes: "Notes",
} as const;

const sectionKeys = Object.keys(sectionTitles) as [keyof typeof sectionTitles, ...(keyof typeof sectionTitles)[]];

function normalizeTaskSlug(slug: string): string {
  const normalized = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return normalized || "task";
}

function taskBlockName(slug: string): { slug: string; name: string } {
  const normalized = normalizeTaskSlug(slug);
  return { slug: normalized, name: `task:${normalized}`.slice(0, 100) };
}

function listOrPending(items?: string[]): string {
  const clean = (items ?? []).map((item) => item.trim()).filter(Boolean);
  return clean.length ? clean.map((item) => `- ${item}`).join("\n") : "- pending";
}

function textOrPending(value?: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return "- pending";
  return trimmed;
}

function buildTaskContent(params: {
  slug: string;
  goal: string;
  user_intent?: string | undefined;
  acceptance_criteria?: string[] | undefined;
  constraints?: string[] | undefined;
  files?: string[] | undefined;
  notes?: string | undefined;
}): string {
  const now = new Date().toISOString();
  return [
    `# Task Working Memory: ${params.slug}`,
    "",
    "Status: open",
    `Opened At: ${now}`,
    "",
    "## Goal",
    params.goal.trim(),
    "",
    "## User Intent",
    textOrPending(params.user_intent),
    "",
    "## Acceptance Criteria",
    listOrPending(params.acceptance_criteria),
    "",
    "## Constraints",
    listOrPending(params.constraints),
    "",
    "## Files",
    listOrPending(params.files),
    "",
    "## Discovery Map",
    "- pending",
    "",
    "## Analysis",
    "- pending",
    "",
    "## Design Plan",
    "- pending",
    "",
    "## Rejected Options",
    "- pending",
    "",
    "## Layer Implementation Plan",
    "- pending",
    "",
    "## Progress",
    `- ${now}: opened task memory`,
    "",
    "## Test Matrix",
    "- pending",
    "",
    "## Review Checklist",
    "- pending",
    "",
    "## Risks",
    "- pending",
    "",
    "## Durable Extract",
    "- pending",
    "",
    "## Notes",
    textOrPending(params.notes),
  ].join("\n");
}

function updateSection(content: string, sectionTitle: string, update: string, operation: "append" | "replace"): string {
  const lines = content.split("\n");
  const heading = `## ${sectionTitle}`;
  const start = lines.findIndex((line) => line.trim() === heading);
  const now = new Date().toISOString();
  const body =
    operation === "replace" ? update.trim() : [`### ${now}`, update.trim()].filter(Boolean).join("\n").trim();

  if (start === -1) {
    return `${content.trimEnd()}\n\n${heading}\n${body}\n`;
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }

  const before = lines.slice(0, start + 1);
  const existing = lines
    .slice(start + 1, end)
    .join("\n")
    .trim();
  const after = lines.slice(end);
  const nextBody =
    operation === "replace" || existing === "- pending" || existing.length === 0 ? body : `${existing}\n\n${body}`;

  return [...before, nextBody, ...after].join("\n").trimEnd() + "\n";
}

async function getTaskBlock(service: MemoryService, slug: string) {
  const task = taskBlockName(slug);
  const blocks = await service.listMemoryBlocks();
  const block = blocks.find((candidate) => candidate.name === task.name);
  if (!block) throw new ValidationError(`Task memory not found: ${task.name}`);
  return { ...task, block };
}

export function registerTaskMemoryTools(server: McpServer, service: MemoryService) {
  server.registerTool(
    "open_task_memory",
    {
      description:
        "Open a short-lived Task Working Memory workbench in the current repository before multi-step discovery, planning, editing, testing, or review. Use this after initial memory grounding and keep it updated until close_task_memory.",
      inputSchema: {
        slug: z.string().min(1).max(120).describe("Stable task slug, for example add-auth-rate-limit"),
        goal: z.string().min(1).describe("Task goal"),
        user_intent: z.string().optional().describe("The user's strongest intent in plain words"),
        acceptance_criteria: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        files: z.array(z.string()).optional(),
        notes: z.string().optional(),
        max_tokens: z.number().min(500).max(5000).default(3000),
      },
      annotations: { title: "Open Task Memory", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const task = taskBlockName(params.slug);
      const content = buildTaskContent({ ...params, slug: task.slug });
      const block = await service.updateMemoryBlock(task.name, content, params.max_tokens, "replace");
      const sessionMemory = await service.remember({
        content: [
          `Current task working memory: ${params.goal}`,
          `Task: ${task.name}`,
          params.files?.length ? `Files: ${params.files.join(", ")}` : "",
          params.notes ? `Notes: ${params.notes}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
        memory_type: "episode",
        tags: [
          "task-working-memory",
          "session-context",
          `task:${task.slug}`,
          ...(params.files ?? []).map((file) => `file:${file}`),
        ],
        ttl_days: 30,
        created_by: ctx.user_id,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              slug: task.slug,
              name: task.name,
              block,
              session_memory_id: sessionMemory.id,
              repository: sessionMemory.repository_slug,
            }),
          },
        ],
      };
    }, "open_task_memory"),
  );

  server.registerTool(
    "update_task_memory",
    {
      description:
        "Update the active Task Working Memory workbench with layered discovery, analysis, design, rejected options, implementation progress, tests, review, risks, or durable extracts.",
      inputSchema: {
        slug: z.string().min(1).max(120),
        section: z.enum(sectionKeys),
        content: z.string().min(1),
        operation: z.enum(["append", "replace"]).default("append"),
        max_tokens: z.number().min(500).max(5000).default(3000),
      },
      annotations: { title: "Update Task Memory", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const { slug, name, block } = await getTaskBlock(service, params.slug);
      const sectionTitle = sectionTitles[params.section];
      const content = updateSection(block.content, sectionTitle, params.content, params.operation);
      const updated = await service.updateMemoryBlock(name, content, params.max_tokens, "replace");
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ slug, name, section: sectionTitle, updated }) }],
      };
    }, "update_task_memory"),
  );

  server.registerTool(
    "get_task_memory",
    {
      description: "Read the current Task Working Memory workbench for the active repository.",
      inputSchema: { slug: z.string().min(1).max(120) },
      annotations: { title: "Get Task Memory", readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    withErrorHandling(async ({ slug }) => {
      const task = await getTaskBlock(service, slug);
      return { content: [{ type: "text" as const, text: JSON.stringify(task) }] };
    }, "get_task_memory"),
  );

  server.registerTool(
    "close_task_memory",
    {
      description:
        "Close a Task Working Memory workbench: record outcome, digest durable learnings, and delete the short-lived scratch block by default.",
      inputSchema: {
        slug: z.string().min(1).max(120),
        outcome: z.string().min(1),
        durable_summary: z.string().optional(),
        delete_scratch: z.boolean().default(true),
      },
      annotations: { title: "Close Task Memory", readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    withErrorHandling(async (params) => {
      requireWritePermission();
      const ctx = getRequestContextOrDefault();
      const { slug, name, block } = await getTaskBlock(service, params.slug);
      const closedAt = new Date().toISOString();
      const closedContent = updateSection(
        updateSection(block.content, "Durable Extract", params.durable_summary ?? params.outcome, "append"),
        "Progress",
        `closed at ${closedAt}: ${params.outcome}`,
        "append",
      ).replace("Status: open", "Status: closed");
      const closedBlock = await service.updateMemoryBlock(name, closedContent, block.max_tokens, "replace");
      const digest = await service.digestSession({
        summary: [
          `Task Working Memory closed: ${params.outcome}`,
          params.durable_summary ? `Durable summary: ${params.durable_summary}` : "",
          `Task slug: ${slug}`,
        ]
          .filter(Boolean)
          .join("\n"),
        tags: ["task-working-memory", `task:${slug}`],
        created_by: ctx.user_id,
      });
      const deleted = params.delete_scratch ? await service.deleteMemoryBlock(name) : false;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              slug,
              name,
              closed: true,
              durable_memories_created: digest.created,
              scratch_deleted: deleted,
              block: params.delete_scratch ? undefined : closedBlock,
            }),
          },
        ],
      };
    }, "close_task_memory"),
  );
}

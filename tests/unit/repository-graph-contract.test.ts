import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

describe("repository graph contract", () => {
  test("install prompt teaches manual edge rules", () => {
    const prompt = readProjectFile("INSTALL_AGENT_PROMPT.md");

    expect(prompt).toContain("Graph and relation rules");
    expect(prompt).toContain("If this contract is present, Local Memory MCP is required");
    expect(prompt).toContain("Do not treat missing");
    expect(prompt).toContain("Local Memory MCP is the agent core");
    expect(prompt).toContain("Before any task, call `get_active_context`");
    expect(prompt).toContain("Without Local Memory MCP, stop and report the blocker");
    expect(prompt).toContain("Memory-Controlled Completion Protocol");
    expect(prompt).toContain("Task Working Memory Protocol");
    expect(prompt).toContain("open_task_memory");
    expect(prompt).toContain("update_task_memory");
    expect(prompt).toContain("get_task_memory");
    expect(prompt).toContain("close_task_memory");
    expect(prompt).toContain("routes/endpoints, services, repositories, clients, permissions/auth");
    expect(prompt).toContain("Use `set_session_context` only as lightweight current-work context");
    expect(prompt).toContain("requirements traceability matrix");
    expect(prompt).toContain("maintain a coverage map in memory");
    expect(prompt).toContain("Run negative checks");
    expect(prompt).toContain("Run conflict checks");
    expect(prompt).toContain("runtime or active-install proof");
    expect(prompt).toContain("red-team pass");
    expect(prompt).toContain("close Task Working Memory with");
    expect(prompt).toContain("Task memory has three layers");
    expect(prompt).toContain("TTL 30 days by default");
    expect(prompt).toContain("5 days when `task_kind=microtask`");
    expect(prompt).toContain("durable_summary");
    expect(prompt).toContain("Do not promote administrative task text");
    expect(prompt).toContain("do not link memories just because they share a tag");
    expect(prompt).toContain("entity overlap is a search signal");
    expect(prompt).toContain("prefer `correct` over manual `supersedes`");
    expect(prompt).not.toContain("installed and available");
    expect(prompt).not.toContain("This contract applies only");
    expect(prompt).not.toContain("At the start of a non-" + "trivial task");
    expect(prompt).not.toContain("when " + "useful");
  });

  test("README is human-facing and delegates agent behavior to install prompt", () => {
    const readme = readProjectFile("README.md");

    expect(readme).toContain("This README is for humans");
    expect(readme).toContain("Agent behavior is defined by");
    expect(readme).toContain("INSTALL_AGENT_PROMPT.md");
    expect(readme).toContain("Do not copy this README as an agent contract");
    expect(readme).toContain("Task Working Memory for multi-step tasks");
    expect(readme).toContain("open_task_memory");
    expect(readme).toContain("update_task_memory");
    expect(readme).toContain("get_task_memory");
    expect(readme).toContain("close_task_memory");
    expect(readme).toContain("Task Working Memory has three layers");
    expect(readme).toContain("TTL 30 days by default");
    expect(readme).toContain("5 days");
    expect(readme).toContain("durable memory only for reusable");
    expect(readme).not.toContain("Use memory when " + "it helps the task");
    expect(readme).not.toContain("At the start of non-" + "trivial work");
  });

  test("ARQAWA install prompt bootstraps retrieval tooling without index tools", () => {
    const prompt = readProjectFile("INSTALL_ARQAWA_WORK_GLOBAL_PROMPT.md");

    expect(prompt).toContain("ARQAWA host work setup");
    expect(prompt).toContain("GLOBAL_CODE_RETRIEVAL_POLICY");
    expect(prompt).toContain("RTK for token-efficient shell output");
    expect(prompt).toContain("probe");
    expect(prompt).toContain("fff-mcp");
    expect(prompt).toContain("ast_grep");
    expect(prompt).toContain("ast-grep-server");
    expect(prompt).toContain("rust-analyzer");
    expect(prompt).toContain("gopls");
    expect(prompt).toContain("jdtls");
    expect(prompt).toContain("basedpyright");
    expect(prompt).toContain("typescript-language-server");
    expect(prompt).toContain("yaml-language-server");
    expect(prompt).toContain("bash-language-server");
    expect(prompt).toContain("docker-langserver");
    expect(prompt).toContain("It does not install Local Memory MCP");
    expect(prompt).toContain("It does not configure memory MCP servers");
    expect(prompt).toContain("mcp_servers.local-memory");
    expect(prompt).toContain("required = true");
    expect(prompt).toContain("It must preserve any existing `LOCAL_MEMORY_MCP_AGENT_CONTRACT` block");
    expect(prompt).toContain("Local Memory MCP is the agent core");
    expect(prompt).toContain("This does not disable Local Memory MCP reads");
    expect(prompt).toContain("These efficiency rules never override required Local Memory MCP calls");
    expect(prompt).toContain("Temporary Handoff Files");
    expect(prompt).toContain("For simple questions");
    expect(prompt).toContain("high-stakes claims");
    expect(prompt).toContain("outside explicit install verification");
    expect(prompt).toContain("$HOME/.local/share/arqawa-work/ARQAWA_WORK_GLOBAL_RULES.md");
    expect(prompt).toContain("memory coverage map and approved proof plan are closed");
    expect(prompt).toContain("must not install index-based tools such as `graphify` or `symlens`");
    expect(prompt).not.toContain("$HOME/.local/share/local-memory-mcp/ARQAWA_WORK_GLOBAL_RULES.md");
  });

  test("server and tool descriptions teach the memory core workflow", () => {
    const server = readProjectFile("src/server.ts");
    const recallTools = readProjectFile("src/tools/recall.ts");
    const rememberTools = readProjectFile("src/tools/remember.ts");
    const manageTools = readProjectFile("src/tools/manage.ts");
    const sessionTools = readProjectFile("src/tools/session.ts");
    const taskMemoryTools = readProjectFile("src/tools/task-memory.ts");
    const toolsIndex = readProjectFile("src/tools/index.ts");

    expect(server).toContain("Local Memory MCP is the agent core");
    expect(server).toContain("Before any task, call get_active_context");
    expect(server).toContain("Task Working Memory workbench");
    expect(server).toContain("open_task_memory");
    expect(server).toContain("one TTL task artifact");
    expect(server).toContain("use digest_session only for separate session-level consolidation");
    expect(server).toContain("routes/endpoints, services, repositories, clients, permissions/auth");
    expect(server).toContain("maintain a coverage map in memory");
    expect(server).toContain("Memory-Controlled Completion Protocol");
    expect(server).toContain("negative loophole checks");
    expect(server).toContain("conflict checks");
    expect(server).toContain("red-team pass");
    expect(recallTools).toContain("Use before analysis, planning, editing, review");
    expect(recallTools).toContain("Call before any task because Local Memory MCP is the agent core");
    expect(rememberTools).toContain("requirements traceability matrices");
    expect(manageTools).toContain("Prefer this over writing a competing truth beside the old one");
    expect(manageTools).toContain("Do not link just because memories share a tag");
    expect(sessionTools).toContain("requirements coverage, decisions, red-team findings");
    expect(sessionTools).toContain("open_task_memory/update_task_memory/close_task_memory");
    expect(taskMemoryTools).toContain("registerTaskMemoryTools");
    expect(taskMemoryTools).toContain("Task Working Memory");
    expect(taskMemoryTools).toContain("discovery_map");
    expect(taskMemoryTools).toContain("layer_implementation_plan");
    expect(taskMemoryTools).toContain("durable_extract");
    expect(taskMemoryTools).toContain("artifact_ttl_days");
    expect(taskMemoryTools).toContain("task_kind");
    expect(taskMemoryTools).toContain("microtask");
    expect(taskMemoryTools).toContain("durable_memory_type");
    expect(taskMemoryTools).toContain("task-artifact");
    expect(taskMemoryTools).toContain("durable-promotion");
    expect(taskMemoryTools).not.toContain("service.digestSession");
    expect(taskMemoryTools).not.toContain("Task slug:");
    expect(toolsIndex).toContain("registerTaskMemoryTools");
  });

  test("install prompt requires Codex local-memory server", () => {
    const prompt = readProjectFile("INSTALL_AGENT_PROMPT.md");

    expect(prompt).toContain("set `required = true` for `mcp_servers.local-memory`");
    expect(prompt).toContain("Codex config must mark `mcp_servers.local-memory` with `required = true`");
  });

  test("ID tools resolve repository scope before reading or writing", () => {
    const recallTools = readProjectFile("src/tools/recall.ts");
    const manageTools = readProjectFile("src/tools/manage.ts");

    expect(recallTools).toContain("const resolved = await service.resolveRepository");
    expect(recallTools).toContain("await service.getMemory(id, resolved.repository_id");
    expect(manageTools).toContain("const repository = await service.currentRepository()");
    expect(manageTools).toContain("repository.id");
  });

  test("SQLite schema keeps repository graph, FTS, and vector tables", () => {
    const schema = readProjectFile("src/db/migrations/001_schema.sql");

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS repositories");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS memories");
    expect(schema).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5");
    expect(schema).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5");
    expect(schema).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0");
    expect(schema).toContain("FOREIGN KEY (source_memory_id, repository_id)");
    expect(schema).toContain("FOREIGN KEY (entity_id, repository_id)");
  });

  test("repo-scoped semantic search uses the local vector table", () => {
    const repo = readProjectFile("src/repositories/memory.repository.ts");

    expect(repo).toContain("FROM memory_vectors");
    expect(repo).toContain("embedding MATCH ?");
    expect(repo).toContain("repository_pk = ?");
    expect(repo).toContain("JOIN ranked ON ranked.memory_pk = m.pk");
  });

  test("entity search uses SQLite trigram FTS and matched counts", () => {
    const repo = readProjectFile("src/repositories/entity.repository.ts");
    const schema = readProjectFile("src/db/migrations/001_schema.sql");
    const proof = readProjectFile("scripts/search-performance-proof.ts");

    expect(repo).toContain("JOIN entities_fts");
    expect(repo).toContain("WITH matched AS");
    expect(repo).toContain("JOIN matched e ON e.id = me.entity_id");
    expect(schema).toContain("tokenize='trigram'");
    expect(proof).toContain("entity search common");
  });

  test("repository identity hardening requires canonical repository identity", () => {
    const schema = readProjectFile("src/db/migrations/001_schema.sql");
    const migrate = readProjectFile("src/db/migrate.ts");

    expect(schema).toContain("root_path TEXT NOT NULL");
    expect(schema).toContain("root_hash TEXT NOT NULL UNIQUE");
    expect(schema).toContain("json_extract(metadata, '$.identity_kind')");
    expect(migrate).toContain("for (const file of files)");
  });
});

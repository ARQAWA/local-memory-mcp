import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

describe("repository graph contract", () => {
  test("install prompt teaches the public context-pack memory contract", () => {
    const prompt = readProjectFile("INSTALL_AGENT_PROMPT.md");
    const contract = prompt.slice(
      prompt.indexOf("<!-- BEGIN LOCAL_MEMORY_MCP_AGENT_CONTRACT -->"),
      prompt.indexOf("<!-- END LOCAL_MEMORY_MCP_AGENT_CONTRACT -->"),
    );

    expect(prompt).toContain("If this contract is present, Local Memory MCP is required");
    expect(prompt).toContain("Do not treat missing");
    expect(prompt).toContain("Local Memory MCP is the agent's proxy to project memory");
    expect(prompt).toContain("prepare_context(auto)");
    expect(prompt).toContain("prepare_context(light)");
    expect(prompt).toContain("Work from the returned `context_pack`");
    expect(prompt).toContain("Do not read raw memory records directly");
    expect(prompt).toContain("commit_task");
    expect(prompt).toContain("correct_memory");
    expect(prompt).toContain("Do not store agent guesses as `current` truth");
    expect(prompt).toContain("Without Local Memory MCP, stop and report the blocker");
    expect(prompt).toContain("Memory-Controlled Completion Protocol");
    expect(prompt).toContain("requirements traceability matrix");
    expect(prompt).toContain("Use `prepare_context(auto)` before planning the work");
    expect(prompt).toContain("Run negative checks");
    expect(prompt).toContain("Run conflict checks");
    expect(prompt).toContain("runtime or active-install proof");
    expect(prompt).toContain("red-team pass");
    expect(prompt).toContain("Useful tools:");
    expect(prompt).toContain("The Qwen3 GGUF llama.cpp reranker is mandatory");
    expect(prompt).toContain("pnpm run setup:reranker");
    expect(prompt).toContain("pnpm run doctor");
    expect(prompt).toContain("MCP schemas must expose only");
    expect(prompt).toContain("MCP schemas must not expose raw memory read, write, graph, or maintenance");
    expect(prompt).not.toContain("installed and available");
    expect(prompt).not.toContain("This contract applies only");
    expect(prompt).not.toContain("At the start of a non-" + "trivial task");
    expect(prompt).not.toContain("when " + "useful");
    expect(contract).not.toContain("Before any task, call `get_active_context`");
    expect(contract).not.toContain("Task Working Memory Protocol");
    expect(contract).not.toContain("open_task_memory");
    expect(contract).not.toContain("recall`");
    expect(contract).not.toContain("get_context_for");
  });

  test("README is human-facing and delegates agent behavior to install prompt", () => {
    const readme = readProjectFile("README.md");

    expect(readme).toContain("This README is for humans");
    expect(readme).toContain("Agent behavior is defined by");
    expect(readme).toContain("INSTALL_AGENT_PROMPT.md");
    expect(readme).toContain("Do not copy this README as an agent contract");
    expect(readme).toContain("prepare_context");
    expect(readme).toContain("commit_task");
    expect(readme).toContain("correct_memory");
    expect(readme).toContain("Raw memory tools are not public");
    expect(readme).toContain("Qwen3-Reranker-0.6B.Q4_K_M.gguf");
    expect(readme).toContain("fallback or none mode");
    expect(readme).toContain("MCP stdio processes are proxy connectors only");
    expect(readme).toContain("memoryd");
    expect(readme).toContain("memoryd.sock");
    expect(readme).toContain("many MCP sessions -> one `memoryd` -> one Qwen3 llama.cpp runtime");
    expect(readme).toContain("no per-MCP model load");
    expect(readme).toContain("pnpm run setup:reranker");
    expect(readme).toContain("pnpm run doctor");
    expect(readme).toContain("INSTALL_PROFILES.md");
    expect(readme).toContain("pnpm run smoke:librarian-modes");
    expect(readme).toContain("pnpm run smoke:singleton");
    expect(readme).toContain("Backend-boundary command hooks are internal dev/debug support only");
    expect(readme).toContain("not proof of a native client subagent");
    expect(readme).not.toContain("LOCAL_MEMORY_LIBRARIAN_CMD");
    expect(readme).not.toContain("LOCAL_MEMORY_LIBRARIAN_MODE");
    expect(readme).not.toContain("Use memory when " + "it helps the task");
    expect(readme).not.toContain("At the start of non-" + "trivial work");
    expect(readme).not.toContain("LOCAL_MEMORY_RERANKER=none");
    expect(readme).not.toContain("open_task_memory");
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
    expect(prompt).toContain("This does not disable Local Memory MCP reads");
    expect(prompt).toContain("These efficiency rules never override required Local Memory MCP calls");
    expect(prompt).toContain("Temporary Handoff Files");
    expect(prompt).toContain("For simple questions");
    expect(prompt).toContain("high-stakes claims");
    expect(prompt).toContain("outside explicit install verification");
    expect(prompt).toContain("Do not write fallback rule files");
    expect(prompt).toContain("memory coverage map and approved proof plan are closed");
    expect(prompt).toContain("must not install index-based tools such as `graphify` or `symlens`");
    expect(prompt).not.toContain("$HOME/.local/share/arqawa-work/ARQAWA_WORK_GLOBAL_RULES.md");
    expect(prompt).not.toContain("$HOME/.local/share/local-memory-mcp/ARQAWA_WORK_GLOBAL_RULES.md");
  });

  test("server and tool registry expose only the context-pack workflow", () => {
    const server = readProjectFile("src/server.ts");
    const projectMemoryTools = readProjectFile("src/tools/project-memory.ts");
    const toolsIndex = readProjectFile("src/tools/index.ts");

    expect(server).toContain("Local Memory MCP is the agent's proxy");
    expect(server).toContain("proxy only");
    expect(server).toContain("singleton local memoryd backend");
    expect(server).toContain("prepare_context(auto)");
    expect(server).toContain("Work from the returned context_pack");
    expect(server).toContain("commit_task");
    expect(server).toContain("correct_memory");
    expect(server).toContain("Public tools are intentionally limited");
    expect(server).toContain("Qwen3 GGUF llama.cpp reranker");
    expect(server).not.toContain("get_active_context");
    expect(server).not.toContain("open_task_memory");
    expect(server).not.toContain("recall or get_context_for");
    expect(projectMemoryTools).toContain("registerProjectMemoryTools");
    expect(projectMemoryTools).toContain("prepare_context");
    expect(projectMemoryTools).toContain("commit_task");
    expect(projectMemoryTools).toContain("correct_memory");
    expect(projectMemoryTools).toContain("mandatory local Qwen3 GGUF llama.cpp reranker");
    expect(toolsIndex).toContain("registerProjectMemoryTools");
    for (const banned of [
      "registerRecallTools",
      "registerRememberTools",
      "registerManageTools",
      "registerTaskMemoryTools",
      "registerBlockTools",
      "registerEnterpriseTools",
    ]) {
      expect(toolsIndex).not.toContain(banned);
    }
  });

  test("install prompt requires Codex local-memory server", () => {
    const prompt = readProjectFile("INSTALL_AGENT_PROMPT.md");

    expect(prompt).toContain("set `required = true` for `mcp_servers.local-memory`");
    expect(prompt).toContain("Codex config must mark `mcp_servers.local-memory` with `required = true`");
    expect(prompt).toContain("Do not change the host agent personality, tone, style rules, or ARQAWA");
    expect(prompt).toContain("~/.codex/config.toml");
    expect(prompt).toContain("~/.codex/AGENTS.md");
    expect(prompt).toContain("INSTALL_PROFILES.md");
  });

  test("install prompt documents fresh-session agent route and host configs", () => {
    const prompt = readProjectFile("INSTALL_AGENT_PROMPT.md");

    expect(prompt).toContain("Client-specific short instructions");
    expect(prompt).toContain("Claude Code:");
    expect(prompt).toContain("claude mcp add local-memory --scope user");
    expect(prompt).toContain("Allow it to inherit configured MCP tools");
    expect(prompt).toContain("Cursor:");
    expect(prompt).toContain("~/.cursor/mcp.json");
    expect(prompt).toContain(".cursor/mcp.json");
    expect(prompt).toContain("GitHub Copilot / VS Code:");
    expect(prompt).toContain("code --add-mcp");
    expect(prompt).toContain("~/.copilot/mcp-config.json");
    expect(prompt).toContain("prepare_context(auto)` -> work -> `prepare_context(light)` -> `commit_task");
    expect(prompt).toContain("MCP stdio is a proxy connector only");
    expect(prompt).toContain("memoryd.sock");
    expect(prompt).toContain("many MCP sessions -> one `memoryd` -> one Qwen3 llama.cpp runtime");
    expect(prompt).toContain("VACUUM INTO");
    expect(prompt).toContain("pnpm run smoke:singleton");
    expect(prompt).toContain("agent-initiated before the");
    expect(prompt).toContain("Native librarian verification must use the client's native subagent trace");
    expect(prompt).toContain("not objectively provable");
    expect(prompt).toContain("Do not replace native client proof with backend command hook smoke");
    expect(prompt).not.toContain("LOCAL_MEMORY_LIBRARIAN_CMD");
    expect(prompt).not.toContain("LOCAL_MEMORY_LIBRARIAN_MODE");
    expect(prompt).toContain("pnpm run smoke:mcp-session");
    expect(prompt).toContain("pnpm run smoke:librarian-modes");
    expect(prompt).toContain("pnpm run smoke:reranker-memory");
  });

  test("install profiles cover supported clients and verification commands", () => {
    const profiles = readProjectFile("INSTALL_PROFILES.md");

    expect(profiles).toContain("# Local Memory MCP Install Profiles");
    expect(profiles).toContain("## Codex");
    expect(profiles).toContain("~/.codex/config.toml");
    expect(profiles).toContain("required = true");
    expect(profiles).toContain("## Claude Code");
    expect(profiles).toContain("claude mcp add local-memory --scope user");
    expect(profiles).toContain("Allow it to inherit configured MCP tools");
    expect(profiles).toContain("memoryd` is the singleton backend");
    expect(profiles).toContain("memoryd.sock");
    expect(profiles).toContain("memory-librarian");
    expect(profiles).toContain("prepare_context(auto) -> work -> prepare_context(light) -> commit_task");
    expect(profiles).toContain("Codex main agent -> Codex native memory-librarian -> prepare_context(deep)");
    expect(profiles).toContain("not native client subagent proof");
    expect(profiles).not.toContain("LOCAL_MEMORY_LIBRARIAN_CMD");
    expect(profiles).not.toContain("LOCAL_MEMORY_LIBRARIAN_MODE");
    expect(profiles).toContain("## Cursor");
    expect(profiles).toContain("~/.cursor/mcp.json");
    expect(profiles).toContain("cursor-agent mcp list-tools local-memory");
    expect(profiles).toContain("## VS Code / GitHub Copilot");
    expect(profiles).toContain(".vscode/mcp.json");
    expect(profiles).toContain("~/.copilot/mcp-config.json");
    expect(profiles).toContain("copilot mcp add local-memory");
    expect(profiles).toContain("pnpm run smoke:mcp-session");
    expect(profiles).toContain("pnpm run smoke:librarian-modes");
    expect(profiles).toContain("pnpm run smoke:singleton");
    expect(profiles).toContain("pnpm run smoke:reranker-memory");
    expect(profiles).toContain("prepare_context");
    expect(profiles).toContain("commit_task");
    expect(profiles).toContain("correct_memory");
  });

  test("SQLite schema keeps repository graph, FTS, vector tables, and card migration", () => {
    const schema = readProjectFile("src/db/migrations/001_schema.sql");
    const cardMigration = readProjectFile("src/db/migrations/003_project_memory_cards.sql");

    expect(schema).toContain("CREATE TABLE IF NOT EXISTS repositories");
    expect(schema).toContain("CREATE TABLE IF NOT EXISTS memories");
    expect(schema).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5");
    expect(schema).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5");
    expect(schema).toContain("CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0");
    expect(schema).toContain("FOREIGN KEY (source_memory_id, repository_id)");
    expect(schema).toContain("FOREIGN KEY (entity_id, repository_id)");
    expect(cardMigration).toContain("ADD COLUMN card_type");
    expect(cardMigration).toContain("ADD COLUMN status");
    expect(cardMigration).toContain("ADD COLUMN source_type");
    expect(cardMigration).toContain("ADD COLUMN confidence");
    expect(cardMigration).toContain("ADD COLUMN anchors_json");
    expect(cardMigration).toContain("ADD COLUMN metadata_json");
    expect(cardMigration).toContain("ADD COLUMN supersedes_id");
    expect(cardMigration).toContain("idx_memories_repository_status");
    expect(cardMigration).toContain("idx_memories_repository_card_type");
  });

  test("repo-scoped semantic search uses the local vector table", () => {
    const repo = readProjectFile("src/repositories/memory.repository.ts");

    expect(repo).toContain("FROM memory_vectors");
    expect(repo).toContain("embedding MATCH ?");
    expect(repo).toContain("repository_pk = ?");
    expect(repo).toContain("JOIN ranked ON ranked.memory_pk = m.pk");
  });

  test("stats and project search keep indexed performance paths", () => {
    const repo = readProjectFile("src/repositories/memory.repository.ts");
    const migration = readProjectFile("src/db/migrations/002_access_count_indexes.sql");

    expect(repo).toContain("private listMostAccessed");
    expect(repo).toContain("ORDER BY m.access_count DESC, m.last_accessed_at DESC, m.updated_at DESC");
    expect(repo).toContain("FROM memories_fts");
    expect(repo).toContain("memories_fts MATCH ?");
    expect(repo).toContain("searchByTagsEntitiesAndText");
    expect(repo).toContain("listByCardTypes");
    expect(repo).not.toContain("m.content LIKE ? OR m.summary LIKE ?");
    expect(migration).toContain("idx_memories_access_count_active");
    expect(migration).toContain("idx_memories_repository_access_count_active");
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
    expect(migrate).toContain("backupDatabaseBeforeMigrations");
    expect(migrate).toContain("VACUUM INTO");
    expect(migrate).toContain("for (const file of pendingFiles)");
  });
});

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
    expect(prompt).toContain("This contract applies only when Local Memory MCP tools are installed");
    expect(prompt).toContain("do not link memories just because they share a tag");
    expect(prompt).toContain("entity overlap is a search signal");
    expect(prompt).toContain("prefer `correct` over manual `supersedes`");
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
    expect(prompt).toContain("must not install index-based tools such as `graphify` or `symlens`");
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

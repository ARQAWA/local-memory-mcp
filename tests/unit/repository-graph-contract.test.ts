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
    expect(prompt).not.toContain("This prompt installs work rules only");
    expect(prompt).not.toContain("It does not configure MCP servers.");
    expect(prompt).not.toContain("START_ARQAWA_WORK_GLOBAL_RULES_COPY");
  });

  test("ID tools resolve repository scope before reading or writing", () => {
    const recallTools = readProjectFile("src/tools/recall.ts");
    const manageTools = readProjectFile("src/tools/manage.ts");

    expect(recallTools).toContain("const resolved = await service.resolveRepository");
    expect(recallTools).toContain("await service.getMemory(id, resolved.repository_id");
    expect(manageTools).toContain("const repository = await service.currentRepository()");
    expect(manageTools).toContain("repository.id");
  });

  test("repo-scoped semantic search uses an exact per-repository candidate scan", () => {
    const repo = readProjectFile("src/repositories/memory.repository.ts");

    expect(repo).toContain("WITH repo_candidates AS MATERIALIZED");
    expect(repo).toContain("FROM repo_candidates");
    expect(repo).toContain("JOIN ranked ON ranked.id = m.id");
    expect(repo).toContain("ORDER BY m.embedding <=>");
  });

  test("hardening migration adds repo constraints and graph metadata", () => {
    const migration = readProjectFile("src/db/migrations/005_repository_graph_hardening.sql");

    expect(migration).toContain("memory_tags_memory_repository_fkey");
    expect(migration).toContain("memory_relations_source_repository_fkey");
    expect(migration).toContain("memory_entities_entity_repository_fkey");
    expect(migration).toContain("origin TEXT NOT NULL DEFAULT 'manual'");
    expect(migration).toContain("WITH (m = 24, ef_construction = 128)");
  });

  test("repository identity hardening requires canonical repository identity", () => {
    const migration = readProjectFile("src/db/migrations/006_repository_identity_hardening.sql");
    const metadataMigration = readProjectFile("src/db/migrations/007_repository_metadata_object_hardening.sql");
    const migrate = readProjectFile("src/db/migrate.ts");

    expect(migration).toContain("root_path SET NOT NULL");
    expect(migration).toContain("repositories_root_hash_sha256");
    expect(migration).toContain("repositories_metadata_identity_kind");
    expect(metadataMigration).toContain("repositories_metadata_is_object");
    expect(migrate).toContain("for (const migration of pending)");
  });

  test("schema and cleanup migration remove redundant single-column graph constraints", () => {
    const schema = readProjectFile("src/db/migrations/001_repository_schema.sql");
    const cleanup = readProjectFile("src/db/migrations/009_drop_redundant_repository_constraints.sql");

    expect(schema).toContain("memory_tags_memory_repository_fkey");
    expect(schema).toContain("memory_relations_source_repository_fkey");
    expect(schema).toContain("entity_relations_source_repository_fkey");
    expect(cleanup).toContain("redundant_fk");
    expect(cleanup).toContain("conname NOT IN");
    expect(cleanup).toContain("memory_tags_memory_repository_fkey");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

describe("static UI repository contract", () => {
  test("main UI keeps the full repository-first visualizer shell", () => {
    const html = readProjectFile("public/index.html");

    for (const marker of ["Dashboard", "Memories", "Search", "Graph", "Repository"]) {
      expect(html).toContain(marker);
    }

    expect(html).toContain("repository_mode");
    expect(html).toContain("/repositories");
    expect(html).toContain("/relations/");
  });

  test("admin UI keeps dashboard and all memories shell", () => {
    const html = readProjectFile("public/admin.html");

    for (const marker of ["Dashboard", "All Memories", "By Repository", "Repository", "pagination"]) {
      expect(html).toContain(marker);
    }
  });

  test("active UI does not contain legacy identity contract terms", () => {
    const activeUi = `${readProjectFile("public/index.html")}\n${readProjectFile("public/admin.html")}`;
    const banned = [
      "All orgs",
      "org_id",
      "team_slug",
      "AutoScope",
      "memory_policies",
      "set_memory_policy",
      "local_only",
      "by_scope",
      "by_org",
      "by_team",
      "All scopes",
      "filter-scope",
      "scope-badge",
      ">Scope<",
    ];

    for (const term of banned) {
      expect(activeUi).not.toContain(term);
    }
  });
});

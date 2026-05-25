import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

describe("backend-only contract", () => {
  test("web and admin UI source files are removed", () => {
    for (const path of [
      "public",
      "public/index.html",
      "public/admin.html",
      "src/api",
      "src/api/routes.ts",
      "src/api/admin-routes.ts",
      "bin/local-memory-web.sh",
    ]) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  test("package exposes only the MCP backend command", () => {
    const pkg = JSON.parse(readProjectFile("package.json")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.bin).toEqual({ "local-memory-mcp": "dist/index.js" });
    expect(pkg.scripts).not.toHaveProperty("web");
    expect(pkg.scripts).not.toHaveProperty("dev:web");
    expect(pkg.scripts).toHaveProperty("setup:reranker");
    expect(pkg.scripts).toHaveProperty("doctor");
    expect(pkg.scripts).toHaveProperty("smoke:singleton");
    expect(pkg.dependencies).not.toHaveProperty("express");
    expect(pkg.dependencies).not.toHaveProperty("helmet");
    expect(pkg.devDependencies).not.toHaveProperty("@types/express");
    expect(JSON.stringify(pkg)).not.toContain("hono");
  });

  test("runtime entry point is stdio proxy only", () => {
    const index = readProjectFile("src/index.ts");

    expect(index).toContain("StdioServerTransport");
    expect(index).toContain("MemorydProxyClient");
    expect(index).toContain("memoryd");
    expect(index).not.toContain("MemoryService");
    expect(index).not.toContain("JinaRerankerService");
    expect(index).not.toContain("runMigrations");
    expect(index).not.toContain("express");
    expect(index).not.toContain("helmet");
    expect(index).not.toContain("registerAdminRoutes");
    expect(index).not.toContain("registerApiRoutes");
    expect(index).not.toContain("--web");
  });
});

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();

function readProjectFile(path: string): string {
  return readFileSync(join(root, path), "utf-8");
}

function legacyPath(...parts: string[]): string {
  return parts.join("");
}

describe("proxy-only contract", () => {
  test("legacy app surface files are removed", () => {
    for (const path of [
      "public",
      "public/index.html",
      legacyPath("public/", "ad", "min.html"),
      "src/api",
      legacyPath("src/api/", "ro", "utes.ts"),
      legacyPath("src/api/", "ad", "min-routes.ts"),
      legacyPath("bin/local-memory-", "we", "b.sh"),
    ]) {
      expect(existsSync(join(root, path))).toBe(false);
    }
  });

  test("package exposes only the MCP proxy command", () => {
    const pkg = JSON.parse(readProjectFile("package.json")) as {
      bin?: Record<string, string>;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    expect(pkg.bin).toEqual({ "local-memory-mcp": "dist/index.js" });
    expect(pkg.scripts).not.toHaveProperty(legacyPath("we", "b"));
    expect(pkg.scripts).not.toHaveProperty(legacyPath("dev:", "we", "b"));
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
    expect(index).not.toContain("LlamaCppRerankerService");
    expect(index).not.toContain("runMigrations");
    expect(index).not.toContain("express");
    expect(index).not.toContain("helmet");
    expect(index).not.toContain(legacyPath("register", "Ad", "min", "Routes"));
    expect(index).not.toContain(legacyPath("register", "Api", "Routes"));
    expect(index).not.toContain(legacyPath("--", "we", "b"));
  });
});

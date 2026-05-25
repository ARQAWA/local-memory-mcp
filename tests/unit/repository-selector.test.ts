import { describe, expect, test } from "vitest";
import { RecallSchema, RepositorySelectorSchema } from "../../src/types/memory.js";

describe("RepositorySelectorSchema", () => {
  test("defaults to current repository for MCP/tool calls", () => {
    expect(RepositorySelectorSchema.parse({})).toEqual({ repository_mode: "current" });
  });

  test("accepts deliberate all-repository reads", () => {
    expect(RepositorySelectorSchema.parse({ repository_mode: "all" })).toEqual({ repository_mode: "all" });
  });

  test("requires repository when mode is specific", () => {
    const result = RepositorySelectorSchema.safeParse({ repository_mode: "specific" });
    expect(result.success).toBe(false);
  });

  test("rejects repository outside specific mode", () => {
    const result = RepositorySelectorSchema.safeParse({ repository_mode: "all", repository: "superbot" });
    expect(result.success).toBe(false);
  });

  test("rejects unknown identity fields", () => {
    const result = RepositorySelectorSchema.safeParse({
      repository_mode: "all",
      identity_key: "unexpected",
    });
    expect(result.success).toBe(false);
  });

  test("legacy query schema defaults to hard graph enrichment", () => {
    const parsed = RecallSchema.parse({ query: "repo graph", limit: 5, token_budget: 1000 });
    expect(parsed.graph_mode).toBe("hard");
  });
});

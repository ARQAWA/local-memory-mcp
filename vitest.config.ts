import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    globals: true,
    pool: "forks",
    testTimeout: 10000,
  },
});

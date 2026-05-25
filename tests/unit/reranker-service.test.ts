import { describe, expect, test } from "vitest";
import { LlamaCppRerankerService } from "../../src/services/reranker.service.js";

describe("llama.cpp Qwen3 reranker service", () => {
  test("startup fails clearly when llama-server is missing", async () => {
    const reranker = new LlamaCppRerankerService({
      appRoot: "/tmp/local-memory-missing-app",
      llamaServerPath: "/tmp/local-memory-missing-app/bin/llama-server",
      modelPath: "/tmp/local-memory-missing-model",
      startupTimeoutMs: 10,
      requestTimeoutMs: 10,
    });

    await expect(reranker.start()).rejects.toThrow("memory is not operational without Qwen3 GGUF reranker");
  });
});

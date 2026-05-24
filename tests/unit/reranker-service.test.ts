import { describe, expect, test } from "vitest";
import { JinaRerankerService } from "../../src/services/reranker.service.js";

describe("Jina reranker service", () => {
  test("startup fails clearly when Python venv is missing", async () => {
    const reranker = new JinaRerankerService({
      appRoot: "/tmp/local-memory-missing-app",
      pythonPath: "/tmp/local-memory-missing-app/.venv/bin/python",
      workerPath: "/tmp/local-memory-missing-app/python/jina_reranker_worker.py",
      modelPath: "/tmp/local-memory-missing-model",
      startupTimeoutMs: 10,
      requestTimeoutMs: 10,
    });

    await expect(reranker.start()).rejects.toThrow("memory is not operational without Jina MLX reranker");
  });
});

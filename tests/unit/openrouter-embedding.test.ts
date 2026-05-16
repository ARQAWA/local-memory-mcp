import http from "node:http";
import { afterEach, expect, test } from "vitest";
import { resetConfig } from "../../src/config.js";
import { getEmbeddingProvider, resetEmbeddingProvider } from "../../src/services/embedding.service.js";

afterEach(() => {
  resetConfig();
  resetEmbeddingProvider();
  delete process.env["EMBEDDING_PROVIDER"];
  delete process.env["OPENROUTER_API_KEY"];
  delete process.env["OPENROUTER_BASE_URL"];
  delete process.env["EMBEDDING_MODEL"];
  delete process.env["EMBEDDING_DIMENSION"];
});

test("OpenRouter embeddings send model and 256 dimensions", async () => {
  let seenBody: { model?: string; dimensions?: number; input?: unknown } | null = null;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += String(chunk);
    });
    req.on("end", () => {
      seenBody = JSON.parse(body) as typeof seenBody;
      const input = Array.isArray(seenBody?.input) ? seenBody.input : [seenBody?.input];
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: input.map(() => ({
            embedding: Array.from({ length: 256 }, (_, i) => i / 256),
          })),
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected TCP server address");

  process.env["EMBEDDING_PROVIDER"] = "openrouter";
  process.env["OPENROUTER_API_KEY"] = "test-key";
  process.env["OPENROUTER_BASE_URL"] = `http://127.0.0.1:${address.port}`;
  process.env["EMBEDDING_MODEL"] = "openai/text-embedding-3-small";
  process.env["EMBEDDING_DIMENSION"] = "256";

  resetConfig();
  resetEmbeddingProvider();
  const embedding = await getEmbeddingProvider().embed("hello");
  server.close();

  expect(embedding).toHaveLength(256);
  expect(seenBody?.model).toBe("openai/text-embedding-3-small");
  expect(seenBody?.dimensions).toBe(256);
});

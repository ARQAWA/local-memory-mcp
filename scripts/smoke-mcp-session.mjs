#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  envWith,
  expectedTools,
  makeSmokeTempDir,
  memorydSmokeEnv,
  parseToolText,
  shellQuote,
  stopSmokeMemoryd,
} from "./memoryd-smoke-utils.mjs";

const root = process.cwd();
const tempDir = makeSmokeTempDir("local-memory-mcp-smoke-");
const tracePath = join(tempDir, "librarian-input.json");
const librarianPath = join(tempDir, "librarian-command.mjs");

writeFileSync(
  librarianPath,
  `import { writeFileSync } from "node:fs";

const tracePath = process.argv[2];
let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  writeFileSync(tracePath, input);
  process.stdout.write(JSON.stringify({
    sections: { "Librarian": ["live librarian command was used"] },
    used_memory_ids: [],
    confidence: 0.99,
    missing_info: []
  }));
});
`,
);

const client = new Client({ name: "local-memory-mcp-smoke", version: "0.1.0" });
const command = process.env["LOCAL_MEMORY_SMOKE_COMMAND"] ?? "pnpm";
const args = process.env["LOCAL_MEMORY_SMOKE_COMMAND"]
  ? (process.env["LOCAL_MEMORY_SMOKE_ARGS"] ?? "").split("\u0000").filter(Boolean)
  : ["exec", "tsx", "src/index.ts", "--stdio"];
const transport = new StdioClientTransport({
  command,
  args,
  cwd: root,
  stderr: "pipe",
  env: envWith({
    ...memorydSmokeEnv(tempDir, {
      LOCAL_MEMORY_LIBRARIAN_MODE: "always",
      LOCAL_MEMORY_LIBRARIAN_CMD: `${shellQuote(process.execPath)} ${shellQuote(librarianPath)} ${shellQuote(tracePath)}`,
      LOCAL_MEMORY_LIBRARIAN_TIMEOUT_MS: "10000",
    }),
  }),
});

let stderr = "";
transport.stderr?.on("data", (chunk) => {
  stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-4000);
});

try {
  await client.connect(transport, { timeout: 180000 });
  const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
  if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
    throw new Error(`unexpected tools: ${tools.join(", ")}`);
  }

  const result = parseToolText(
    await client.callTool(
      {
        name: "prepare_context",
        arguments: {
          task: "live smoke: verify librarian command",
          mode: "light",
          use_librarian: "always",
          token_budget: 300,
        },
      },
      undefined,
      { timeout: 180000 },
    ),
  );
  if (!result.context_pack.includes("live librarian command was used")) {
    throw new Error("prepare_context did not use librarian output");
  }

  const payload = JSON.parse(readFileSync(tracePath, "utf-8"));
  if (payload.task !== "live smoke: verify librarian command" || payload.mode !== "light") {
    throw new Error("librarian command did not receive expected JSON input");
  }

  console.log(JSON.stringify({ ok: true, tools, librarian_called: true, mode: payload.mode }));
} catch (err) {
  if (stderr.trim()) console.error(stderr.trim());
  throw err;
} finally {
  await client.close().catch(() => undefined);
  await stopSmokeMemoryd(tempDir);
  rmSync(tempDir, { recursive: true, force: true });
}

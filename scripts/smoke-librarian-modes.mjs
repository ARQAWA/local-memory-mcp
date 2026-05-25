#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  envWith,
  expectedTools,
  makeSmokeTempDir,
  memorydSmokeEnv,
  parseToolText,
  shellQuote,
  smokeServerCommand,
  stopSmokeMemoryd,
} from "./memoryd-smoke-utils.mjs";

const root = process.cwd();

function writeLibrarianCommand(dir) {
  const tracePath = join(dir, "librarian-trace.json");
  const commandPath = join(dir, "librarian-command.mjs");
  writeFileSync(
    commandPath,
    `import { writeFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const payload = JSON.parse(input);
  if (String(payload.task).includes("failure")) process.exit(2);
  writeFileSync(${JSON.stringify(tracePath)}, input);
  process.stdout.write(JSON.stringify({
    sections: { "Librarian": ["librarian command was used"] },
    used_memory_ids: [],
    confidence: 0.99,
    missing_info: []
  }));
});
`,
  );
  return {
    tracePath,
    command: `${shellQuote(process.execPath)} ${shellQuote(commandPath)}`,
  };
}

async function seed(client, summary) {
  const result = await client.callTool(
    {
      name: "commit_task",
      arguments: {
        task_summary: summary,
        decisions: [`${summary} decision card`],
      },
    },
    undefined,
    { timeout: 180000 },
  );
  if (result.isError) throw new Error(`seed failed: ${result.content?.[0]?.text ?? "unknown error"}`);
}

async function prepare(client, task, extra = {}) {
  const result = await client.callTool(
    {
      name: "prepare_context",
      arguments: {
        task,
        mode: "light",
        token_budget: 500,
        ...extra,
      },
    },
    undefined,
    { timeout: 180000 },
  );
  if (result.isError) throw new Error(result.content?.[0]?.text ?? "prepare_context failed");
  return parseToolText(result);
}

async function main() {
  const tempDir = makeSmokeTempDir("local-memory-librarian-modes-");
  const { command: librarianCommand, tracePath } = writeLibrarianCommand(tempDir);
  const client = new Client({ name: "local-memory-librarian-modes", version: "0.1.0" });
  const { command, args } = smokeServerCommand();
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: root,
    stderr: "pipe",
    env: envWith(
      memorydSmokeEnv(tempDir, {
        LOCAL_MEMORY_LIBRARIAN_MODE: "auto",
        LOCAL_MEMORY_LIBRARIAN_CMD: librarianCommand,
        LOCAL_MEMORY_LIBRARIAN_TIMEOUT_MS: "10000",
      }),
    ),
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

    await seed(client, "librarian off fallback");
    const off = await prepare(client, "librarian off fallback", { use_librarian: "never" });
    if (existsSync(tracePath)) throw new Error("use_librarian=never called librarian command");
    if (!off.context_pack.includes("librarian off fallback")) {
      throw new Error("off mode did not return local fallback pack");
    }

    await seed(client, "librarian auto failure");
    const auto = await prepare(client, "librarian auto failure");
    if (!auto.context_pack.includes("librarian auto failure")) {
      throw new Error("auto mode failure did not return local fallback pack");
    }

    await seed(client, "librarian always failure");
    const always = await client.callTool(
      {
        name: "prepare_context",
        arguments: {
          task: "librarian always failure",
          mode: "light",
          token_budget: 500,
          use_librarian: "always",
        },
      },
      undefined,
      { timeout: 180000 },
    );
    if (!always.isError) throw new Error("always mode failure did not fail prepare_context");
    const text = always.content?.[0]?.text ?? "";
    if (!text.includes("Librarian command")) {
      throw new Error(`always mode failed with wrong error: ${text}`);
    }

    console.log(JSON.stringify({ ok: true, modes: ["off", "auto", "always"] }));
  } catch (err) {
    if (stderr.trim()) console.error(stderr.trim());
    throw err;
  } finally {
    await client.close().catch(() => undefined);
    await stopSmokeMemoryd(tempDir);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();

#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import {
  envWith,
  expectedTools,
  makeSmokeTempDir,
  memorydSmokeEnv,
  parseToolText,
  smokeServerCommand,
  stopSmokeMemoryd,
} from "./memoryd-smoke-utils.mjs";

const root = process.cwd();

function requestStatus(stateDir) {
  const socketPath = join(stateDir, "memoryd.sock");
  const request = { id: randomUUID(), method: "doctor/status" };
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffer = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("memoryd status request timed out"));
    }, 180000);
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      clearTimeout(timer);
      socket.destroy();
      const response = JSON.parse(buffer.slice(0, newline));
      if (!response.ok) {
        reject(new Error(response.error?.message ?? "memoryd status failed"));
        return;
      }
      resolve(response.result);
    });
    socket.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function createSession(index, tempDir) {
  const client = new Client({ name: `local-memory-singleton-${index}`, version: "0.1.0" });
  const { command, args } = smokeServerCommand();
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: root,
    stderr: "pipe",
    env: envWith(memorydSmokeEnv(tempDir, { LOCAL_MEMORY_LIBRARIAN_MODE: "off" })),
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-4000);
  });
  try {
    await client.connect(transport, { timeout: 180000 });
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    if (JSON.stringify(tools) !== JSON.stringify(expectedTools)) {
      throw new Error(`session ${index} unexpected tools: ${tools.join(", ")}`);
    }
    return { client, stderr: () => stderr };
  } catch (err) {
    if (stderr.trim()) console.error(stderr.trim());
    throw err;
  }
}

async function prepareFromSession(session, index, stateDir) {
  const result = parseToolText(
    await session.client.callTool(
      {
        name: "prepare_context",
        arguments: {
          task: `singleton smoke session ${index}`,
          mode: "light",
          token_budget: 300,
          use_librarian: "never",
        },
      },
      undefined,
      { timeout: 180000 },
    ),
  );
  if (typeof result.context_pack !== "string") throw new Error(`session ${index} returned invalid context_pack`);
  const status = await requestStatus(stateDir);
  return {
    index,
    memoryd_pid: status.pid,
    qwen_runtime_pid: status.qwen_runtime_pid,
    mode_used: result.mode_used,
  };
}

async function main() {
  const tempDir = makeSmokeTempDir("local-memory-singleton-");
  const stateDir = join(tempDir, "state");
  const sessions = [];
  try {
    sessions.push(...(await Promise.all([1, 2, 3].map((index) => createSession(index, tempDir)))));
    const results = await Promise.all(
      sessions.map((session, index) => prepareFromSession(session, index + 1, stateDir)),
    );
    const memorydPids = [...new Set(results.map((result) => result.memoryd_pid))];
    const runtimePids = [...new Set(results.map((result) => result.qwen_runtime_pid).filter(Boolean))];
    if (memorydPids.length !== 1) throw new Error(`expected 1 memoryd pid, got ${memorydPids.join(", ")}`);
    if (runtimePids.length !== 1) throw new Error(`expected 1 llama.cpp runtime pid, got ${runtimePids.join(", ")}`);
    console.log(
      JSON.stringify({
        ok: true,
        sessions: results.length,
        memoryd_pid: memorydPids[0],
        qwen_runtime_pid: runtimePids[0],
        route: "3 MCP stdio sessions -> 1 memoryd -> 1 Qwen3 llama.cpp runtime",
      }),
    );
  } catch (err) {
    for (const session of sessions) {
      const stderr = session.stderr();
      if (stderr.trim()) console.error(stderr.trim());
    }
    throw err;
  } finally {
    await Promise.all(sessions.map((session) => session.client.close().catch(() => undefined)));
    await stopSmokeMemoryd(tempDir);
    rmSync(tempDir, { recursive: true, force: true });
  }
}

await main();

#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createConnection } from "node:net";
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
const maxBytes = 3 * 1024 * 1024 * 1024;

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

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function psRssBytes(pids) {
  if (pids.length === 0) return 0;
  const result = spawnSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf-8", stdio: "pipe" });
  if (result.status !== 0) return null;
  return result.stdout
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isFinite(value))
    .reduce((sum, value) => sum + value * 1024, 0);
}

function footprintBytes(pids) {
  if (process.platform !== "darwin" || pids.length === 0) return null;
  const dir = mkdtempSync(join(tmpdir(), "local-memory-footprint-"));
  const output = join(dir, "footprint.json");
  try {
    const args = ["-j", output, "-f", "bytes", ...pids.map(String)];
    const result = spawnSync("footprint", args, { encoding: "utf-8", stdio: "pipe", timeout: 15000 });
    if (result.status !== 0 || !existsSync(output)) return null;
    const parsed = JSON.parse(readFileSync(output, "utf-8"));
    return typeof parsed["total footprint"] === "number" ? parsed["total footprint"] : null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function measure(label, pids) {
  const alive = pids.filter((pid) => Number.isInteger(pid) && pid > 0 && processAlive(pid));
  const footprint = footprintBytes(alive);
  const rss = psRssBytes(alive);
  const bytes = footprint ?? rss ?? 0;
  return { label, pids: alive, bytes, footprint_bytes: footprint, rss_bytes: rss };
}

async function createSession(index, tempDir) {
  const client = new Client({ name: `local-memory-reranker-memory-${index}`, version: "0.1.0" });
  const { command, args } = smokeServerCommand();
  const transport = new StdioClientTransport({
    command,
    args,
    cwd: root,
    stderr: "pipe",
    env: envWith(
      memorydSmokeEnv(tempDir, {
        LOCAL_MEMORY_LIBRARIAN_MODE: "off",
        LOCAL_MEMORY_RERANKER_IDLE_TIMEOUT_MS: "2000",
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
      throw new Error(`session ${index} unexpected tools: ${tools.join(", ")}`);
    }
    return { client, stderr: () => stderr };
  } catch (err) {
    if (stderr.trim()) console.error(stderr.trim());
    throw err;
  }
}

async function seed(client) {
  const decisions = Array.from({ length: 12 }, (_, index) => `Qwen3 llama.cpp memory smoke card ${index}`);
  const result = await client.callTool(
    {
      name: "commit_task",
      arguments: {
        task_summary: "reranker memory smoke seed",
        decisions,
      },
    },
    undefined,
    { timeout: 180000 },
  );
  if (result.isError) throw new Error(result.content?.[0]?.text ?? "seed failed");
}

async function prepare(client) {
  const result = parseToolText(
    await client.callTool(
      {
        name: "prepare_context",
        arguments: {
          task: "Qwen3 llama.cpp memory smoke card",
          mode: "light",
          token_budget: 500,
          use_librarian: "never",
        },
      },
      undefined,
      { timeout: 180000 },
    ),
  );
  if (typeof result.context_pack !== "string") throw new Error("prepare_context returned invalid context_pack");
  return result;
}

async function main() {
  const tempDir = makeSmokeTempDir("local-memory-reranker-memory-");
  const stateDir = join(tempDir, "state");
  const sessions = [];
  try {
    const before = measure("before", []);
    sessions.push(...(await Promise.all([1, 2, 3].map((index) => createSession(index, tempDir)))));
    await seed(sessions[0].client);
    await Promise.all(sessions.map((session) => prepare(session.client)));
    const statuses = await Promise.all(sessions.map(() => requestStatus(stateDir)));
    const memorydPids = [...new Set(statuses.map((status) => status.pid))];
    const runtimePids = [...new Set(statuses.map((status) => status.qwen_runtime_pid).filter(Boolean))];
    if (memorydPids.length !== 1) throw new Error(`expected 1 memoryd pid, got ${memorydPids.join(", ")}`);
    if (runtimePids.length !== 1) throw new Error(`expected 1 llama.cpp runtime pid, got ${runtimePids.join(", ")}`);
    const peak = measure("peak", [memorydPids[0], runtimePids[0]]);
    if (peak.bytes > maxBytes) {
      throw new Error(`reranker memory exceeded 3 GiB: ${peak.bytes} bytes`);
    }

    await new Promise((resolve) => setTimeout(resolve, 5000));
    const idleStatus = await requestStatus(stateDir);
    const idlePids = [idleStatus.pid, idleStatus.qwen_runtime_pid].filter(Boolean);
    const idle = measure("idle", idlePids);
    if (idleStatus.qwen_runtime_pid && processAlive(idleStatus.qwen_runtime_pid)) {
      throw new Error(`llama.cpp runtime still alive after idle timeout: ${idleStatus.qwen_runtime_pid}`);
    }
    if (idle.bytes > peak.bytes) {
      throw new Error(`idle memory did not drop below peak: peak ${peak.bytes}, idle ${idle.bytes}`);
    }

    console.log(
      JSON.stringify({
        ok: true,
        threshold_bytes: maxBytes,
        route: "3 MCP stdio sessions -> 1 memoryd -> 1 Qwen3 llama.cpp runtime",
        memoryd_pid: memorydPids[0],
        qwen_runtime_pid: runtimePids[0],
        before,
        peak,
        idle,
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

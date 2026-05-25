import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const expectedTools = ["commit_task", "correct_memory", "prepare_context"];

export function makeSmokeTempDir(prefix) {
  const base = process.platform === "darwin" ? "/tmp" : tmpdir();
  return mkdtempSync(join(base, prefix));
}

export function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function envWith(overrides) {
  return Object.fromEntries(
    Object.entries({ ...process.env, ...overrides }).filter(([, value]) => typeof value === "string"),
  );
}

export function parseToolText(result) {
  const text = result.content?.find((item) => item.type === "text")?.text;
  if (!text) throw new Error("tool returned no text content");
  return JSON.parse(text);
}

export function smokeServerCommand() {
  if (process.env["LOCAL_MEMORY_SMOKE_COMMAND"]) {
    return {
      command: process.env["LOCAL_MEMORY_SMOKE_COMMAND"],
      args: (process.env["LOCAL_MEMORY_SMOKE_ARGS"] ?? "").split("\u0000").filter(Boolean),
    };
  }
  return { command: "pnpm", args: ["exec", "tsx", "src/index.ts", "--stdio"] };
}

export function memorydSmokeEnv(tempDir, overrides = {}) {
  return {
    LOCAL_MEMORY_STATE_DIR: join(tempDir, "state"),
    LOCAL_MEMORY_DB_PATH: join(tempDir, "smoke.sqlite3"),
    LOCAL_MEMORY_REPOSITORY_ROOT: tempDir,
    EMBEDDING_PROVIDER: "noop",
    ASYNC_EMBEDDING: "false",
    ...overrides,
  };
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export async function stopSmokeMemoryd(tempDir) {
  const stateDir = join(tempDir, "state");
  const pidPath = join(stateDir, "memoryd.pid");
  if (existsSync(pidPath)) {
    const pid = Number(readFileSync(pidPath, "utf-8").trim());
    if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
      process.kill(pid, "SIGTERM");
      await waitForExit(pid);
    }
  }
  for (const file of ["memoryd.sock", "memoryd.pid", "memoryd.lock"]) {
    rmSync(join(stateDir, file), { force: true });
  }
}

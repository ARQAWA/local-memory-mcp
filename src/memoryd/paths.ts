import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MemorydPaths {
  stateDir: string;
  socketPath: string;
  pidPath: string;
  lockPath: string;
  logPath: string;
}

export function getMemorydPaths(): MemorydPaths {
  const stateDir = process.env["LOCAL_MEMORY_STATE_DIR"] ?? join(homedir(), ".local", "share", "local-memory-mcp");
  return {
    stateDir,
    socketPath: join(stateDir, "memoryd.sock"),
    pidPath: join(stateDir, "memoryd.pid"),
    lockPath: join(stateDir, "memoryd.lock"),
    logPath: join(stateDir, "memoryd.log"),
  };
}

export function ensureMemorydStateDir(paths = getMemorydPaths()): void {
  mkdirSync(paths.stateDir, { recursive: true });
}

export function appendMemorydLog(message: string, meta?: Record<string, unknown>, paths = getMemorydPaths()): void {
  ensureMemorydStateDir(paths);
  appendFileSync(
    paths.logPath,
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      message,
      ...meta,
    })}\n`,
  );
}

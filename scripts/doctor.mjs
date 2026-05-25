#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const appRoot = process.cwd();
const dbPath =
  process.env.LOCAL_MEMORY_DB_PATH ?? join(homedir(), ".local", "share", "local-memory-mcp", "local-memory.sqlite3");
const modelPath =
  process.env.LOCAL_MEMORY_RERANKER_MODEL_PATH ??
  join(
    homedir(),
    ".local",
    "share",
    "local-memory-mcp",
    "models",
    "qwen3-reranker-0.6b-gguf",
    "Qwen3-Reranker-0.6B.Q4_K_M.gguf",
  );
const profilePath = join(homedir(), ".local", "share", "local-memory-mcp", "reranker-profile.json");
const distIndex = join(appRoot, "dist", "index.js");
const distMigrate = join(appRoot, "dist", "db", "migrate.js");
const migrationsDir = join(appRoot, "dist", "db", "migrations");

function fail(message) {
  console.error(`doctor failed: ${message}`);
  process.exit(1);
}

function failReranker(message) {
  fail(`memory is not operational without Qwen3 GGUF reranker: ${message}`);
}

function ok(message) {
  console.log(`ok: ${message}`);
}

function commandOk(command, args) {
  const result = spawnSync(command, args, { cwd: appRoot, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isInteger(major) || major < 22) fail(`Node >=22 required, got ${process.versions.node}`);
  ok(`Node ${process.versions.node}`);
}

function checkPnpm() {
  ok(`pnpm ${commandOk("pnpm", ["--version"])}`);
}

function checkBuild() {
  for (const path of [distIndex, distMigrate, migrationsDir]) {
    if (!existsSync(path)) fail(`build output missing: ${path}`);
  }
  ok("build output exists");
}

function checkDbAndMigrations() {
  if (!existsSync(dbPath)) fail(`database does not exist: ${dbPath}; run node dist/db/migrate.js`);
  const files = readdirSync(migrationsDir)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT name FROM _migrations").all();
    const applied = new Set(rows.map((row) => String(row.name)));
    const pending = files.filter((file) => !applied.has(file));
    if (pending.length > 0) fail(`pending migrations: ${pending.join(", ")}`);
    ok(`database ${dbPath}`);
    ok(`migrations applied: ${files.length}`);
  } finally {
    db.close();
  }
}

function readProfile() {
  if (!existsSync(profilePath)) failReranker(`profile missing at ${profilePath}; run pnpm run setup:reranker`);
  return JSON.parse(readFileSync(profilePath, "utf-8"));
}

function checkModelAndRuntime(profile) {
  const llamaServer = process.env.LOCAL_MEMORY_LLAMA_SERVER_BIN ?? profile.llama_server_path;
  if (typeof llamaServer !== "string" || llamaServer.length === 0) {
    failReranker("llama-server path missing from profile; run pnpm run setup:reranker");
  }
  commandOk(llamaServer, ["--version"]);
  if (!existsSync(modelPath)) failReranker(`model file missing: ${modelPath}; run pnpm run setup:reranker`);
  const header = readFileSync(modelPath).subarray(0, 4).toString("utf-8");
  if (header !== "GGUF") failReranker(`model file is not GGUF: ${modelPath}`);
  ok(`llama.cpp runtime ${llamaServer}`);
  ok(`Qwen3 GGUF model path ${modelPath}`);
}

async function checkMemoryd() {
  const modulePath = pathToFileURL(join(appRoot, "dist", "memoryd", "client.js")).href;
  const { MemorydProxyClient, ensureMemorydRunning } = await import(modulePath);
  const status = await ensureMemorydRunning();
  if (status.reranker_backend !== "qwen3-gguf-llama.cpp") {
    failReranker(`unexpected reranker backend: ${status.reranker_backend}`);
  }
  if (!status.qwen_ready) failReranker("memoryd reports Qwen3 reranker is not ready");
  if (!status.qwen_runtime_pid) failReranker("memoryd did not report a llama.cpp runtime pid");
  const client = new MemorydProxyClient();
  const doctorStatus = await client.doctorStatus();
  if (doctorStatus.pid !== status.pid) fail("doctor/status returned a different memoryd pid");
  if (doctorStatus.qwen_runtime_pid !== status.qwen_runtime_pid) {
    fail("doctor/status returned a different llama.cpp runtime pid");
  }
  const sample = await client.prepareContext({
    task: "doctor sample rerank for Qwen3 GGUF llama.cpp runtime",
    mode: "light",
    token_budget: 300,
    use_librarian: "never",
  });
  if (typeof sample.context_pack !== "string") failReranker("sample rerank returned invalid context pack");
  for (const path of [status.socket_path, status.pid_path, status.log_path]) {
    if (!existsSync(path)) fail(`memoryd state file missing: ${path}`);
  }
  ok(`memoryd pid ${status.pid}`);
  ok(`Qwen3 llama.cpp runtime pid ${status.qwen_runtime_pid}`);
  ok(`reranker endpoint ${status.reranker_endpoint ?? "not reported"}`);
  ok(`sample rerank mode ${sample.mode_used}`);
  ok(`memoryd socket ${status.socket_path}`);
  ok(`memoryd log ${status.log_path}`);
}

checkNode();
checkPnpm();
checkBuild();
checkDbAndMigrations();
const profile = readProfile();
checkModelAndRuntime(profile);
await checkMemoryd();
ok("doctor passed");

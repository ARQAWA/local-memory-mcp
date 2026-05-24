#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const appRoot = process.cwd();
const dbPath = process.env.LOCAL_MEMORY_DB_PATH ?? join(homedir(), ".local", "share", "local-memory-mcp", "local-memory.sqlite3");
const modelPath =
  process.env.LOCAL_MEMORY_RERANKER_MODEL_PATH ??
  join(homedir(), ".local", "share", "local-memory-mcp", "models", "jina-reranker-v3-mlx");
const python = process.env.LOCAL_MEMORY_RERANKER_PYTHON ?? join(appRoot, ".venv", "bin", "python");
const distIndex = join(appRoot, "dist", "index.js");
const distMigrate = join(appRoot, "dist", "db", "migrate.js");
const migrationsDir = join(appRoot, "dist", "db", "migrations");

function fail(message) {
  console.error(`doctor failed: ${message}`);
  process.exit(1);
}

function failReranker(message) {
  fail(`memory is not operational without Jina MLX reranker: ${message}`);
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

function checkMacAndPython() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    failReranker(`requires macOS Apple Silicon; got ${process.platform}/${process.arch}`);
  }
  if (!existsSync(python)) failReranker(`Python venv not found at ${python}; run pnpm run setup:reranker`);
  commandOk(python, ["-c", "import mlx, mlx_lm, safetensors, numpy"]);
  ok("macOS Apple Silicon and MLX Python imports");
}

function checkModelPath() {
  for (const file of ["rerank.py", "projector.safetensors", "config.json", "tokenizer.json"]) {
    const path = join(modelPath, file);
    if (!existsSync(path)) failReranker(`model file missing: ${path}; run pnpm run setup:reranker`);
  }
  ok(`model path ${modelPath}`);
}

async function checkRerank() {
  const modulePath = pathToFileURL(join(appRoot, "dist", "services", "reranker.service.js")).href;
  const { JinaRerankerService } = await import(modulePath);
  const reranker = new JinaRerankerService({ appRoot, pythonPath: python, modelPath });
  try {
    await reranker.start();
    const results = await reranker.healthCheck();
    if (results.length < 2) failReranker("sample rerank returned too few results");
    ok(`sample rerank top=${results[0].id} score=${results[0].score.toFixed(4)}`);
  } finally {
    await reranker.close();
  }
}

checkNode();
checkPnpm();
checkBuild();
checkDbAndMigrations();
checkMacAndPython();
checkModelPath();
await checkRerank();
ok("doctor passed");

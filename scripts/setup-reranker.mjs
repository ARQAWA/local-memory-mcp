#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { get } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";

const appRoot = process.cwd();
const dataRoot = join(homedir(), ".local", "share", "local-memory-mcp");
const modelDir = join(dataRoot, "models", "qwen3-reranker-0.6b-gguf");
const modelRepo = "QuantFactory/Qwen3-Reranker-0.6B-GGUF";
const modelFile = "Qwen3-Reranker-0.6B.Q4_K_M.gguf";
const modelPath = process.env.LOCAL_MEMORY_RERANKER_MODEL_PATH ?? join(modelDir, modelFile);
const profilePath = join(dataRoot, "reranker-profile.json");
const modelUrl = `https://huggingface.co/${modelRepo}/resolve/main/${modelFile}`;
const minModelBytes = 100 * 1024 * 1024;

function fail(message) {
  console.error(`memory is not operational without Qwen3 GGUF reranker: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: appRoot, stdio: "inherit", ...options });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
}

function commandOutput(command, args) {
  const result = spawnSync(command, args, { cwd: appRoot, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) return "";
  return result.stdout.trim();
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function commandPath(command) {
  return commandOutput("bash", ["-lc", `command -v ${shellQuote(command)}`]);
}

function checkLlamaServer(path) {
  const result = spawnSync(path, ["--version"], { cwd: appRoot, stdio: "pipe", encoding: "utf-8" });
  if (result.status !== 0) fail(`llama-server check failed at ${path}: ${(result.stderr || result.stdout).trim()}`);
}

function findOrInstallLlamaServer() {
  const configured = process.env.LOCAL_MEMORY_LLAMA_SERVER_BIN ?? process.env.LOCAL_MEMORY_LLAMA_SERVER_PATH;
  if (configured) {
    checkLlamaServer(configured);
    return configured;
  }

  let llamaServer = commandPath("llama-server");
  if (llamaServer) {
    checkLlamaServer(llamaServer);
    return llamaServer;
  }

  const brew = commandPath("brew");
  if (!brew) fail("llama-server was not found and Homebrew is not available to install llama.cpp");
  run(brew, ["install", "llama.cpp"]);

  llamaServer = commandPath("llama-server");
  if (!llamaServer) fail("Homebrew finished but llama-server is still not on PATH");
  checkLlamaServer(llamaServer);
  return llamaServer;
}

function verifyGguf(path) {
  if (!existsSync(path)) return false;
  if (statSync(path).size < minModelBytes) return false;
  return readFileSync(path).subarray(0, 4).toString("utf-8") === "GGUF";
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const tmp = `${destination}.part`;
    rmSync(tmp, { force: true });
    const file = createWriteStream(tmp);
    let received = 0;
    let nextReport = 50 * 1024 * 1024;

    const request = get(url, { headers: { "user-agent": "local-memory-mcp-setup" } }, (response) => {
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        file.close();
        rmSync(tmp, { force: true });
        downloadFile(location, destination).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        file.close();
        rmSync(tmp, { force: true });
        reject(new Error(`download failed with HTTP ${status}`));
        return;
      }
      response.on("data", (chunk) => {
        received += chunk.length;
        if (received >= nextReport) {
          console.log(`downloaded ${Math.round(received / 1024 / 1024)} MiB`);
          nextReport += 50 * 1024 * 1024;
        }
      });
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        renameSync(tmp, destination);
        resolve();
      });
    });
    request.on("error", (err) => {
      file.close();
      rmSync(tmp, { force: true });
      reject(err);
    });
  });
}

async function findOpenPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close();
      if (!address || typeof address === "string") {
        reject(new Error("could not allocate local port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function fetchJson(url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text) };
  } finally {
    clearTimeout(timer);
  }
}

function parseScores(body, ids) {
  const results = Array.isArray(body?.results) ? body.results : [];
  return results
    .map((item) => ({
      id: ids[item.index],
      score: typeof item.relevance_score === "number" ? item.relevance_score : item.score,
    }))
    .filter((item) => item.id && typeof item.score === "number")
    .sort((a, b) => b.score - a.score);
}

async function sampleRerank(llamaServerPath) {
  const port = await findOpenPort();
  const endpoint = `http://127.0.0.1:${port}`;
  const child = spawn(
    llamaServerPath,
    [
      "--model",
      modelPath,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--embedding",
      "--pooling",
      "rank",
      "--reranking",
      "--ctx-size",
      "2048",
      "--parallel",
      "1",
      "--no-webui",
    ],
    { cwd: appRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString("utf-8")}`.slice(-8_000);
  });

  try {
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) fail(`llama-server exited during setup sample: ${stderr.trim()}`);
      try {
        const health = await fetchJson(`${endpoint}/health`, { method: "GET" }, 1_000);
        if (health.status === 200) {
          ready = true;
          break;
        }
      } catch {
        // Keep polling until the model finishes loading.
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    if (!ready) fail(`llama-server did not become healthy during setup sample: ${stderr.trim()}`);

    const documents = ["Local Memory MCP uses Qwen3 GGUF reranking through llama.cpp.", "A weather note."];
    const ids = ["relevant", "irrelevant"];
    const response = await fetchJson(
      `${endpoint}/reranking`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "qwen3-reranker-0.6b-q4_k_m", query: "local memory reranker", documents }),
      },
      60_000,
    );
    if (response.status !== 200) fail(`sample rerank failed with HTTP ${response.status}`);
    const scores = parseScores(response.body, ids);
    if (scores[0]?.id !== "relevant") fail(`sample rerank returned wrong top result: ${JSON.stringify(scores)}`);
    return { endpoint, scores };
  } finally {
    child.kill("SIGTERM");
  }
}

const llamaServerPath = findOrInstallLlamaServer();
mkdirSync(modelDir, { recursive: true });
if (!verifyGguf(modelPath)) {
  console.log(`downloading ${modelRepo}/${modelFile}`);
  await downloadFile(modelUrl, modelPath).catch((err) => fail(err instanceof Error ? err.message : String(err)));
}
if (!verifyGguf(modelPath)) fail(`model file is missing or invalid: ${modelPath}`);

const sample = await sampleRerank(llamaServerPath);
mkdirSync(dataRoot, { recursive: true });
writeFileSync(
  profilePath,
  `${JSON.stringify(
    {
      backend: "qwen3-gguf-llama.cpp",
      model_repo: modelRepo,
      model_file: modelFile,
      model_path: modelPath,
      model_license: "apache-2.0",
      llama_server_path: llamaServerPath,
      idle_timeout_ms: 600_000,
      checked_at: new Date().toISOString(),
      sample_rerank: sample.scores,
    },
    null,
    2,
  )}\n`,
);

console.log("Qwen3 GGUF reranker is ready");
console.log(`llama-server: ${llamaServerPath}`);
console.log(`model: ${modelPath}`);
console.log(`profile: ${profilePath}`);

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const appRoot = process.cwd();
const venvDir = join(appRoot, ".venv");
const python = join(venvDir, "bin", "python");
const modelPath =
  process.env.LOCAL_MEMORY_RERANKER_MODEL_PATH ??
  join(homedir(), ".local", "share", "local-memory-mcp", "models", "jina-reranker-v3-mlx");
const workerPath = join(appRoot, "python", "jina_reranker_worker.py");

function fail(message) {
  console.error(`memory is not operational without Jina MLX reranker: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: appRoot, stdio: "inherit", ...options });
  if (result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed with exit ${result.status ?? "null"}`);
  }
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  fail(`requires macOS Apple Silicon; got ${process.platform}/${process.arch}`);
}

if (!existsSync(venvDir)) {
  run("python3", ["-m", "venv", venvDir]);
}

run(python, ["-m", "pip", "install", "--upgrade", "pip"]);
run(python, [
  "-m",
  "pip",
  "install",
  "huggingface_hub[hf_xet]>=0.26.0",
  "mlx>=0.0.1",
  "mlx-lm>=0.0.1",
  "numpy>=1.24.0",
  "safetensors>=0.4.0",
]);

mkdirSync(modelPath, { recursive: true });
const downloadScript = `
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id="jinaai/jina-reranker-v3-mlx",
    local_dir=${JSON.stringify(resolve(modelPath))},
)
`;
run(python, ["-c", downloadScript]);

for (const file of ["rerank.py", "projector.safetensors", "config.json", "tokenizer.json"]) {
  if (!existsSync(join(modelPath, file))) fail(`model file is missing: ${join(modelPath, file)}`);
}
if (!existsSync(workerPath)) fail(`worker file is missing: ${workerPath}`);

run(python, ["-c", "import mlx, mlx_lm, safetensors, numpy; print('mlx import ok')"]);
run(python, [workerPath, "--model-path", modelPath, "--check"]);

console.log(`Jina MLX reranker is ready`);
console.log(`venv: ${venvDir}`);
console.log(`model: ${modelPath}`);

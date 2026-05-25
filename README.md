# Local Memory MCP

Local-only MCP proxy for lightweight project memory.

This README is for humans. Agent behavior is defined by
`INSTALL_AGENT_PROMPT.md`, which installs the managed
`LOCAL_MEMORY_MCP_AGENT_CONTRACT` into the target host's global instructions.

## Model

- One machine has one Local Memory MCP install.
- One machine has one local SQLite database file.
- Memory is stored globally on the host.
- Every memory belongs to exactly one repository.
- Normal reads and writes use the current project.
- A project can be a Git repository or a plain local folder.
- If a plain folder later becomes a Git repository, it keeps the same memory
  because identity is rooted in the canonical project path.
- Cross-repository reads are explicit: use `repository_mode=specific` or
  `repository_mode=all`.
- The runtime surface is MCP stdio proxy plus one local `memoryd` backend.
- MCP stdio processes are proxy connectors only.
- `memoryd` is the only process that opens SQLite, retrieval runtime, and the
  Qwen3 GGUF llama.cpp reranker.
- Multiple clients and MCP sessions share the same `memoryd`.
- Topology: many MCP sessions -> one `memoryd` -> one Qwen3 llama.cpp runtime.
- There is no per-MCP model load.
- Public MCP tools are only `prepare_context`, `commit_task`, and
  `correct_memory`.

There is no per-agent database, per-repository database, or alternate identity
layer.

## Runtime

`memoryd` is a singleton per user and host. The first MCP stdio process starts
it when needed. Later MCP processes reuse it over a Unix socket.

State files:

- `$HOME/.local/share/local-memory-mcp/memoryd.sock`
- `$HOME/.local/share/local-memory-mcp/memoryd.pid`
- `$HOME/.local/share/local-memory-mcp/memoryd.lock`
- `$HOME/.local/share/local-memory-mcp/memoryd.log`

If the pid is stale or the socket is dead, the proxy cleans up state and starts
`memoryd` again. The log records `started`, `reused`, `stopped`,
`stale cleanup`, and `error` events.

Repository identity rows are hardened:

- `root_path` is required;
- `root_hash` must be a SHA-256 hash of the canonical project path;
- repository metadata must be a JSON object;
- repository metadata must include `identity_kind`.

Project memory cards add these fields on `memories`:

- `card_type`
- `status`
- `source_type`
- `confidence`
- `anchors_json`
- `metadata_json`
- `supersedes_id`

Legacy `memory_type` remains for existing SQLite data. New cards map legacy
types to card types:

- `decision` -> `decision`
- `procedure` -> `process`
- `convention` -> `constraint`
- `episode` -> `gotcha`
- `reference` -> `reference`
- all other old types -> `fact`

Status controls retrieval. `wrong` cards are dropped. `deprecated` and
`superseded` cards are shown only in the `Legacy` section of `prepare_context`.

## Tools

- `prepare_context`
- `commit_task`
- `correct_memory`

Raw memory tools are not public. Agents work through `prepare_context`
context packs and write durable task learnings with `commit_task`.

## Retrieval

Retrieval requires Qwen3-Reranker-0.6B GGUF Q4_K_M through `llama.cpp`.
`memoryd` starts exactly one local `llama-server` child process and keeps the
model ready. MCP stdio processes never start the model runtime. There is no
fallback or none mode. If `llama-server`, the GGUF model file, or the sample
rerank check is not ready, `memoryd` startup and `pnpm run doctor` fail with a
clear error.

Default model path:

```bash
$HOME/.local/share/local-memory-mcp/models/qwen3-reranker-0.6b-gguf/Qwen3-Reranker-0.6B.Q4_K_M.gguf
```

`prepare_context(light)` uses FTS, semantic search, tags, and entities to
collect up to 30 candidates. It reranks candidates with Qwen3 GGUF, keeps the top
8-10 after status-aware ordering and deduplication, and targets a 900-token
pack by default.

`prepare_context(deep)` classifies the task, extracts query terms, uses FTS,
semantic search, tags/entities, type-prior search, entity/relation expansion
depth 1, status filtering, mandatory Qwen3 GGUF reranking, and MMR-style
deduplication. It collects up to 40-60 candidates, or at most 80 for high-risk
deep tasks, and targets a 3500-token pack by default.

`prepare_context(auto)` uses deep mode for auth, security, billing, migration,
architecture, debugging, and refactoring work. It starts light for smaller
detail questions, then escalates to deep if confidence is low or conflict
signals appear.

Score fusion weights:

- FTS: `0.35`
- vector: `0.35`
- tags/entities and relation neighbors: `0.10`
- type prior: `0.10`
- importance: `0.05`
- recency: `0.05`

Status modifiers:

- `current`: `+0.20`
- `candidate`: `-0.15`
- `needs_review`: `-0.20`
- `deprecated`: `-0.50`
- `superseded`: `-0.60`
- `wrong`: dropped

Native client librarian:

- Codex main agent can delegate deep memory retrieval to a Codex native
  `memory-librarian` subagent/profile when the host supports native subagents.
- The native librarian uses the same public MCP tool surface and calls
  `prepare_context(deep)`.
- Backend-boundary command hooks are internal dev/debug support only. They are
  not normal client UX and are not proof of a native client subagent.
- Reranking remains mandatory in every mode.

## Agent Instructions

The source of truth for agent behavior is `INSTALL_AGENT_PROMPT.md`.

The installer writes the managed `LOCAL_MEMORY_MCP_AGENT_CONTRACT` into the
host global rules. That contract treats Local Memory MCP as the agent's memory
proxy:
agents call `prepare_context(auto)` before non-trivial tasks, use
`prepare_context(light)` for micro-details, work from the returned
`context_pack`, commit durable task learnings with `commit_task`, avoid writing
secrets, avoid storing guesses as current truth, and correct stale cards with
`correct_memory`.

Do not copy this README as an agent contract.

## Install And Migration

Use `INSTALL_AGENT_PROMPT.md` for a fresh install or reinstall.

Use `INSTALL_PROFILES.md` after install to configure specific clients:
Codex, Claude Code, Cursor, and VS Code / GitHub Copilot.

The installer must:

- clean stale `dist` output before build;
- install dependencies;
- run `pnpm run setup:reranker`;
- run typecheck, lint, and tests;
- build the MCP proxy and `memoryd` backend;
- run migrations;
- create a SQLite backup before pending migrations;
- run `pnpm run doctor`;
- run `pnpm run smoke:mcp-session`;
- run `pnpm run smoke:librarian-modes`;
- run `pnpm run smoke:singleton`;
- run `pnpm run smoke:reranker-memory`;
- create or reuse the local SQLite database file;
- link `local-memory-mcp` into `$HOME/.local/bin`;
- verify a fresh MCP session exposes only `prepare_context`, `commit_task`,
  and `correct_memory`.

Useful live smoke:

```bash
pnpm run smoke:mcp-session
pnpm run smoke:librarian-modes
pnpm run smoke:singleton
pnpm run smoke:reranker-memory
```

The smoke starts a fresh stdio MCP session, verifies the public tool list, runs
`prepare_context`, and checks the internal backend-boundary librarian command
used by dev/debug tests. This command smoke is not native client subagent proof.
The librarian mode smoke verifies:

- `off`: command is not called;
- `auto`: command failure falls back to the local pack;
- `always`: command failure makes `prepare_context` fail.

The singleton smoke starts three MCP stdio sessions and proves they share one
`memoryd` process and one Qwen3 llama.cpp runtime.

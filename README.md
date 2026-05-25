# Local Memory MCP

Local-only MCP backend for lightweight project memory.

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
- The runtime surface is MCP stdio plus one local `memoryd` backend.
- MCP stdio processes are proxy connectors only.
- `memoryd` is the only process that opens SQLite, retrieval runtime, and Jina.
- Multiple clients and MCP sessions share the same `memoryd`.
- There is no per-MCP model load.

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

Legacy `memory_type` remains for old tools and old SQLite data. New cards map
legacy types to card types:

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

Retrieval requires `jinaai/jina-reranker-v3-mlx` on macOS Apple Silicon.
`memoryd` starts exactly one local Python/MLX worker as a child process and
keeps the model ready. MCP stdio processes never start Jina. There is no
fallback or none mode. If the venv, MLX import, model path, or worker is not
ready, `memoryd` startup and `pnpm run doctor` fail with a clear error.

`prepare_context(light)` uses FTS, semantic search, tags, and entities to
collect up to 30 candidates. It reranks candidates with Jina MLX, keeps the top
8-10 after status-aware ordering and deduplication, and targets a 900-token
pack by default.

`prepare_context(deep)` classifies the task, extracts query terms, uses FTS,
semantic search, tags/entities, type-prior search, entity/relation expansion
depth 1, status filtering, mandatory Jina MLX reranking, and MMR-style
deduplication. It collects up to 100-150 candidates and targets a 3500-token
pack by default.

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

Optional librarian:

- `LOCAL_MEMORY_LIBRARIAN_MODE=off|auto|always`
- `LOCAL_MEMORY_LIBRARIAN_CMD`
- `LOCAL_MEMORY_LIBRARIAN_TIMEOUT_MS=30000`

If `LOCAL_MEMORY_LIBRARIAN_MODE=always` and the command fails,
`prepare_context` fails clearly. In `auto` mode, librarian failure falls back
to the local context pack. Reranking remains mandatory in every mode.

## Agent Instructions

The source of truth for agent behavior is `INSTALL_AGENT_PROMPT.md`.

The installer writes the managed `LOCAL_MEMORY_MCP_AGENT_CONTRACT` into the
host global rules. That contract treats Local Memory MCP as the agent core:
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
- build the MCP backend;
- run migrations;
- create a SQLite backup before pending migrations;
- run `pnpm run doctor`;
- run `pnpm run smoke:mcp-session`;
- run `pnpm run smoke:librarian-modes`;
- run `pnpm run smoke:singleton`;
- create or reuse the local SQLite database file;
- link `local-memory-mcp` into `$HOME/.local/bin`;
- verify a fresh MCP session exposes only `prepare_context`, `commit_task`,
  and `correct_memory`.

Useful live smoke:

```bash
pnpm run smoke:mcp-session
pnpm run smoke:librarian-modes
pnpm run smoke:singleton
```

The smoke starts a fresh stdio MCP session, verifies the public tool list, runs
`prepare_context`, and proves a live librarian command receives JSON input and
returns the context pack. The librarian mode smoke verifies:

- `off`: command is not called;
- `auto`: command failure falls back to the local pack;
- `always`: command failure makes `prepare_context` fail.

The singleton smoke starts three MCP stdio sessions and proves they share one
`memoryd` process and one Jina worker.

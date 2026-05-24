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
- There is no browser UI, admin UI, or web route surface.

There is no per-agent database, per-repository database, or alternate identity
layer.

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

Project-memory tools:

- `prepare_context`
- `commit_task`
- `correct_memory`

Core read tools:

- `get_active_context`
- `recall`
- `get_context_for`
- `get_task_memory`
- `get_memory`
- `list_memories`
- `search_memories`
- `get_memory_stats`
- `get_repository_overview`
- `list_repositories`

Core write tools:

- `remember`
- `remember_fact`
- `remember_decision`
- `correct`
- `forget`
- `batch_forget`
- `set_session_context`
- `open_task_memory`
- `update_task_memory`
- `close_task_memory`
- `digest_session`

Maintenance and repair:

- `consolidate`
- `link_memories`
- `get_related`
- `get_group`
- `update_memory_block`
- `get_memory_blocks`
- `delete_memory_block`
- `sync_conventions`
- `export_conventions`
- `import_markdown`
- `export_markdown`
- `query_entities`
- `detect_conflicts`
- `purge_memories`
- `reembed_memories`
- `get_memory_analytics`

## Retrieval

`prepare_context(light)` uses FTS, semantic search, tags, and entities. It does
not use a subagent or graph expansion. It returns 10-15 cards and targets a
900-token pack by default.

`prepare_context(deep)` classifies the task, extracts query terms, uses FTS,
semantic search, tags/entities, type-prior search, relation expansion depth 1,
score fusion, optional reranking, MMR-style deduplication, and status sections.
It targets a 3500-token pack by default.

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

Optional reranker:

- `LOCAL_MEMORY_RERANKER=none|command`
- `LOCAL_MEMORY_RERANKER_CMD`

Optional librarian:

- `LOCAL_MEMORY_LIBRARIAN_MODE=off|auto|always`
- `LOCAL_MEMORY_LIBRARIAN_CMD`
- `LOCAL_MEMORY_LIBRARIAN_TIMEOUT_MS=30000`

If a reranker or librarian command fails, `prepare_context` falls back to local
retrieval.

## Agent Instructions

The source of truth for agent behavior is `INSTALL_AGENT_PROMPT.md`.

The installer writes the managed `LOCAL_MEMORY_MCP_AGENT_CONTRACT` into the
host global rules. That contract treats Local Memory MCP as the agent core:
agents call `prepare_context(auto)` before non-trivial tasks, use
`prepare_context(light)` for micro-details, commit durable task learnings with
`commit_task`, avoid writing secrets, avoid storing guesses as current truth,
maintain Task Working Memory for multi-step tasks, and correct stale cards.

Task Working Memory has three layers:

- scratch while the task is running;
- one small task artifact after close, with TTL 30 days by default or 5 days
  for `task_kind=microtask`;
- durable memory only for reusable facts, decisions, procedures, conventions,
  architecture changes, API/contract changes, bug roots, migrations, non-obvious
  repo patterns, or important negative findings.

Do not copy this README as an agent contract.

## Install And Migration

Use `INSTALL_AGENT_PROMPT.md` for a fresh install or reinstall.

The installer must:

- clean stale `dist` output before build;
- install dependencies;
- run typecheck, lint, and tests;
- build the MCP backend;
- run migrations;
- create a SQLite backup before pending migrations;
- create or reuse the local SQLite database file;
- link `local-memory-mcp` into `$HOME/.local/bin`;
- verify a fresh MCP session exposes project-memory tools.

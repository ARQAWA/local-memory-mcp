# Local Memory MCP

Local-only MCP memory server for AI coding agents.

## Model

- One machine has one Local Memory MCP install.
- One machine has one local PostgreSQL database.
- Memory is stored globally on the host.
- Every memory belongs to exactly one repository.
- Normal reads and writes use the current project.
- A project can be a Git repository or a plain local folder.
- If a plain folder later becomes a Git repository, it keeps the same memory
  because identity is rooted in the canonical project path.
- Cross-repository reads are explicit: use `repository_mode=specific` or
  `repository_mode=all`.
- The Web UI is a global viewer. If it is started outside a project folder, it
  shows all repositories by default and does not invent a current repo.

There is no per-agent database, per-repository database, or legacy identity
compatibility layer.

Default local URLs:

- Web UI: `http://127.0.0.1:13765/ui`
- Admin UI: `http://127.0.0.1:13765/admin`

The Web UI keeps the full viewer shell:

- `Dashboard`
- `Memories`
- `Search`
- `Graph`

The Web UI is repository-first. It defaults to all repositories because the Web
server has no current project context. Selecting one repository switches reads
to `repository_mode=specific`.

Repository identity rows are hardened:

- `root_path` is required;
- `root_hash` cannot use old placeholder values;
- repository metadata must be a JSON object;
- old migration metadata is rejected;
- existing placeholder rows are normalized before hardening migrations run.

Search is repository-correct:

- current/specific semantic search uses an exact per-repository candidate scan;
- explicit all-repository semantic search can use the global HNSW index;
- FTS, tags, entities, relations, and list reads keep repository-keyed indexes.

The Admin UI keeps:

- `Dashboard`
- `All Memories`
- period selector
- repository chart
- memory table pagination
- memory detail modal

## Tools

Core read tools:

- `get_active_context`
- `recall`
- `get_context_for`
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

## Agent Contract

Use memory when it helps the task.

At the start of non-trivial work:

- call `get_active_context`;
- call `recall` or `get_context_for` before important planning or edits;
- call `set_session_context` only when the task context is worth saving.

When the user says "remember", "запомни", or "зафиксируй", write memory
immediately.

Current user instructions and current repository files beat old memory. If a
memory is stale, use `correct`. If it is irrelevant, use `forget`.

Use graph links only for strong durable relationships. `link_memories` is for
explicit current-repository edges, not for shared tags, shared files, or vague
similarity. Use `get_related` for lineage, dependencies, alternatives, and
conflicts. Use `query_entities` for file/API/package/error/env discovery.
Normal recall stays token-efficient; full graph context is opt-in.

Never store secrets, tokens, passwords, private keys, credentials, or private
auth material.

## Install And Migration

Use `INSTALL_AGENT_PROMPT.md` for a fresh install or legacy migration.

The installer must:

- clean stale `dist` output before build;
- run migrations;
- restart the active local Web server;
- verify `/api/repositories`;
- verify `repository_mode=all`;
- verify `/ui/` has `Dashboard`, `Memories`, `Search`, and `Graph`;
- verify `/admin` has `Dashboard` and `All Memories`;
- verify a fresh MCP session exposes only repository-first fields.

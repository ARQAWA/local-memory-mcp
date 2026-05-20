# Local Memory MCP

Local-only MCP memory server for AI coding agents.

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
- The Web UI is a global viewer. If it is started outside a project folder, it
  shows all repositories by default and does not invent a current repo.

There is no per-agent database, per-repository database, or alternate identity
layer.

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
- `root_hash` must be a SHA-256 hash of the canonical project path;
- repository metadata must be a JSON object;
- repository metadata must include `identity_kind`.

Search is repository-correct:

- current/specific semantic search uses an exact per-repository candidate scan;
- explicit all-repository semantic search can scan the shared vector table;
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

## Agent Instructions

The source of truth for agent behavior is `INSTALL_AGENT_PROMPT.md`.

The installer writes the managed `LOCAL_MEMORY_MCP_AGENT_CONTRACT` into the
host global rules. That contract treats Local Memory MCP as the agent core:
agents read memory before work, update durable findings during work, maintain
Task Working Memory for multi-step tasks, maintain coverage maps for broad
audits, correct stale memories, forget noise, and consolidate important
sessions.

Do not copy this README as an agent contract.

## Install And Migration

Use `INSTALL_AGENT_PROMPT.md` for a fresh install or reinstall.

The installer must:

- clean stale `dist` output before build;
- run migrations;
- create or reuse the local SQLite database file;
- restart the active local Web server;
- verify `/api/repositories`;
- verify Web UI default `All repositories`;
- verify `repository_mode=all`;
- verify `/ui/` has `Dashboard`, `Memories`, `Search`, and `Graph`;
- verify `/admin` has `Dashboard` and `All Memories`;
- verify a fresh MCP session exposes only repository-first fields.

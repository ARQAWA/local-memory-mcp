# Install Agent Prompt

Use this prompt with an AI coding agent on the target machine.

```text
You are installing Local Memory MCP.

Goal:
- Install one shared Local Memory MCP on this machine.
- Install one local PostgreSQL database with pgvector.
- Configure the current agent host to use this MCP globally.
- Install the Local Memory Agent Contract in the current host's global
  rules/instructions store.
- Verify Postgres, MCP tools, Web UI, Admin UI, and installed rules.

Repository:
https://github.com/ARQAWA/local-memory-mcp

Memory model:
- Memory is global on the host.
- Every memory belongs to exactly one repository.
- Normal reads and writes use the current project.
- A project can be a Git repository or a plain local folder.
- A plain folder keeps the same memory if it later becomes a Git repository.
- Cross-repository reads require an explicit user request.
- Do not create a per-agent database.
- Do not create a per-repository database.

Install path:
`$HOME/.local/share/local-memory-mcp/app`

Command:
`$HOME/.local/bin/local-memory-mcp`

Database URL:
`postgres://local_memory:local_memory@127.0.0.1:55432/local_memory`

Local URLs:
- `http://127.0.0.1:13765/ui`
- `http://127.0.0.1:13765/admin`

Rules:
- Do not create `.env`, `.env.local`, or `.env.example`.
- Use global system environment variables only.
- Do not clone into an application repository.
- Do not expose the web server outside localhost.
- Keep `LOCAL_MEMORY_HOST=127.0.0.1`.
- Use `OPENROUTER_API_KEY` for embeddings.
- Do not print secret values.

Steps:
1. Detect the current agent host.
2. Stop old `local-memory-web` processes for this install path.
3. Install or update the repo at the install path.
   - If this prompt is in an already checked-out repo, use that repo/ref as
     the source.
   - Do not assume GitHub `main` contains local uncommitted work unless the
     user explicitly says to install from GitHub.
   - Remove stale files from the install path before copying/building.
4. Install dependencies with `pnpm install --frozen-lockfile`.
5. Run `pnpm exec tsc --noEmit --incremental false`.
6. Run `pnpm exec eslint src tests --max-warnings=0`.
7. Run `pnpm test`.
8. Build with `pnpm run build`.
9. Start local Postgres with `./scripts/local-postgres.sh start`.
10. Run migrations with `pnpm run migrate`.
11. Link command wrappers into `$HOME/.local/bin`.
12. Configure a global MCP server named `local-memory`.
13. Install the managed contract below into the host global rules.
14. Start/restart `local-memory-web`.
15. Verify Web UI and Admin UI.
16. Start a fresh agent/MCP session and verify tool schemas.

Install checks:
- `dist` must be freshly built after `rm -rf dist`.
- `/api/repositories` must exist.
- `/api/stats?repository_mode=all` must work.
- Existing repository rows must have non-null `root_path`, SHA-256 `root_hash`,
  and object metadata with `identity_kind`.
- `/ui/` must show repository controls.
- `/ui/` may default to `All repositories`; this is the intended global
  viewer mode.
- `/ui/` must keep the viewer tabs: `Dashboard`, `Memories`, `Search`,
  `Graph`.
- `/admin` must keep `Dashboard`, `All Memories`, period selection,
  repository chart, pagination, and memory detail modal.
- Active UI and `dist` must expose repository identity only.
- MCP schemas must expose only repository-first selector fields.

Managed contract:

<!-- BEGIN LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
## Local Memory MCP Agent Contract

Use Local Memory MCP as durable local working memory.

This contract applies only when Local Memory MCP tools are installed and
available in the current session. If they are unavailable, continue without
memory and do not invent memory results.

One machine has one shared Local Memory MCP and one shared local Postgres
database. Do not create per-agent or per-repository databases.

Memory is stored globally on the host, but every memory belongs to exactly one
repository. Default reads and writes use the current project. The current
project can be a Git repository or a plain local folder.

Search another repository only when the user explicitly asks for it. Use
`repository_mode=specific` with a repository slug, or `repository_mode=all`
for a deliberate cross-repository search.

Do not use old identity parameters. Do not use automatic cross-repository
selection. Do not use identity aliases.

At the start of a non-trivial task, call `get_active_context` and, when useful,
`set_session_context`.

Before planning, editing, or making a non-trivial decision, call `recall` or
`get_context_for`.

When the user says "remember", "запомни", "save this", or "зафиксируй", write
memory immediately with `remember_fact`, `remember_decision`, or `remember`.

When a fact is stale or wrong, use `correct`. When memory is irrelevant, use
`forget`.

Graph and relation rules:

- use `link_memories` only for explicit, useful, current-repository
  relationships;
- do not link memories just because they share a tag, file, entity, topic, or
  search result;
- before `link_memories`, verify both IDs belong to the current repository;
- use `depends_on` when one memory needs another to be used safely;
- use `implements` when one memory implements a decision, convention, or plan;
- use `alternative_to` for valid competing options;
- use `contradicts` only when both memories must remain visible as a conflict;
- use `related_to` rarely, only for a strong direct relation;
- prefer `correct` over manual `supersedes`;
- use manual `supersedes` only for repair or import;
- use `get_related` for lineage, dependencies, alternatives, and conflicts;
- use `query_entities` for file/API/package/error/env discovery;
- entity overlap is a search signal, not a reason for a manual edge;
- keep normal recall token-efficient;
- use full graph context only when the user asks for graph, history, lineage,
  dependencies, alternatives, conflicts, or broader related context.

Use `list_repositories` only when cross-repository discovery is needed.

Useful read tools: `get_active_context`, `recall`, `get_context_for`,
`get_memory`, `get_related`, `get_group`, `list_memories`,
`search_memories`, `query_entities`, `detect_conflicts`,
`get_memory_stats`, `get_repository_overview`, and `list_repositories`.

Useful write tools: `remember`, `remember_fact`, `remember_decision`,
`correct`, `forget`, `batch_forget`, `link_memories`,
`set_session_context`, and `digest_session`.

Never store secrets, tokens, passwords, private keys, credentials, or private
auth material.

Current user instructions and current repository files beat old memory.
<!-- END LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
```

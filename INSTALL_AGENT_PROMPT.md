# Install Agent Prompt

Use this prompt with an AI coding agent on the target machine.

```text
You are installing Local Memory MCP.

Goal:
- Install one shared Local Memory MCP on this machine.
- Use one local SQLite database file.
- Configure the current agent host to use this MCP globally.
- Install the Local Memory Agent Contract in the current host's global
  rules/instructions store.
- Make the Local Memory MCP server required when the host supports required
  MCP servers.
- Verify SQLite, MCP tools, Web UI, Admin UI, and installed rules.

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

Database file:
`$HOME/.local/share/local-memory-mcp/local-memory.sqlite3`

Local URLs:
- `http://127.0.0.1:13765/ui`
- `http://127.0.0.1:13765/admin`

Rules:
- Do not create `.env`, `.env.local`, or `.env.example`.
- Use global system environment variables only.
- Do not clone into an application repository.
- Do not expose the web server outside localhost.
- Keep `LOCAL_MEMORY_HOST=127.0.0.1`.
- Use `LOCAL_MEMORY_DB_PATH` only when the default database path must change.
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
9. Run migrations with `pnpm run migrate`.
10. Link command wrappers into `$HOME/.local/bin`.
11. Configure a global MCP server named `local-memory`.
    - For Codex, set `required = true` for `mcp_servers.local-memory`.
12. Install the managed contract below into the host global rules.
    - Replace only the managed `LOCAL_MEMORY_MCP_AGENT_CONTRACT` block.
    - Preserve unrelated rules and other managed blocks, including ARQAWA
      blocks.
13. Start/restart `local-memory-web`.
14. Verify Web UI and Admin UI.
15. Start a fresh agent/MCP session and verify tool schemas.

Install checks:
- `dist` must be freshly built after `rm -rf dist`.
- The database file must exist after migrations.
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
- MCP schemas must expose Task Working Memory tools:
  `open_task_memory`, `update_task_memory`, `get_task_memory`,
  `close_task_memory`.
- The host global rules must contain exactly one
  `LOCAL_MEMORY_MCP_AGENT_CONTRACT` block.
- If ARQAWA blocks exist, they must remain separate and must not weaken,
  duplicate, or replace the Local Memory MCP contract.
- Codex config must mark `mcp_servers.local-memory` with `required = true`.
- A fresh agent session must expose Local Memory MCP before doing work.

Managed contract:

<!-- BEGIN LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
## Local Memory MCP Agent Contract

Local Memory MCP is the agent core.

If this contract is present, Local Memory MCP is required. Do not treat missing
or unavailable memory tools as permission to continue without memory.

Before any task, call `get_active_context`.

Before analysis, planning, editing, review, or repository-grounded answering, call
`recall` or `get_context_for` with the current topic.

Without Local Memory MCP, stop and report the blocker. Do not continue without
memory and do not invent memory results. The only exception is work whose direct
goal is to install, configure, or repair Local Memory MCP itself.

One machine has one shared Local Memory MCP and one shared local SQLite
database file. Do not create per-agent or per-repository databases.

Memory is stored globally on the host, but every memory belongs to exactly one
repository. Default reads and writes use the current project. The current
project can be a Git repository or a plain local folder. Git is not required
for memory writes.

Search another repository only when the user explicitly asks for it. Use
`repository_mode=specific` with a repository slug, or `repository_mode=all`
for a deliberate cross-repository search.

Do not use old identity parameters. Do not use automatic cross-repository
selection. Do not use identity aliases.

Memory workflow:

- Start every task with `get_active_context`.
- Use `recall` or `get_context_for` before deciding, planning, editing, or
  answering from repository knowledge.
- During analysis, write durable findings as soon as they become useful for
  future work.
- Before writing a new memory, search existing memory to avoid duplicates.
- Prefer short, atomic memories: `fact`, `decision`, `procedure`, `episode`,
  `reference`, or `convention`.
- For broad audits, refactors, migrations, removals, agent-instruction changes,
  or architecture research, maintain a coverage map in memory: goal, acceptance
  criteria, aliases, searched commands, checked files or zones, positive
  findings, negative findings, remaining risks, and proof.
- At the end of important work, call `digest_session` to consolidate the result.

Task Working Memory Protocol:

For any task that needs discovery, planning, edits, tests, review, or more than
one meaningful step, the agent must keep a short-lived task workbench.

1. Start with `get_active_context`.
2. Call `recall` or `get_context_for` for the task topic.
3. Open the workbench with `open_task_memory`.
4. During discovery, update `discovery_map` by layers:
   routes/endpoints, services, repositories, clients, permissions/auth,
   configs, tests, data contracts, docs, active install, and runtime when
   relevant.
5. During analysis, update `analysis` with findings, unknowns, constraints, and
   affected layers.
6. During design, update `design_plan` and `rejected_options` with KISS, YAGNI,
   and SOLID reasoning.
7. During implementation, update `layer_implementation_plan` and `progress` as
   each layer is changed.
8. During proof, update `test_matrix` with requirements, checks, and results.
9. During self-review, update `review_checklist` and `risks`.
10. Before reporting done, call `close_task_memory` with outcome and durable
    summary. It must digest durable learnings and remove or explicitly retain
    short-lived scratch.

Use `set_session_context` only as lightweight current-work context. It does not
replace Task Working Memory for multi-step work.

Memory-Controlled Completion Protocol for broad or high-stakes tasks:

1. Build a requirements traceability matrix from the user's strongest intent.
2. Write or update a memory coverage map before and during the work.
3. Check every affected layer: repository source, docs, tests, host rules,
   config, active install, runtime process, and current-session limitations.
4. Run positive checks that prove the wanted behavior exists.
5. Run negative checks for weak wording, loopholes, stale rules, and removed
   behavior that must stay gone.
6. Run conflict checks against user rules, task-sync rules, retrieval policy,
   read-only mode, tool descriptions, and existing agent instructions.
7. Run runtime or active-install proof when the change affects installed agent
   behavior.
8. Before the final answer, perform a red-team pass: explain how the work could
   still fail, then fix every in-scope gap.
9. Do not report "done" until the coverage map is closed or any remaining gap is
   explicitly reported as a blocker or risk.

Repository read-only, inspection, analysis, or planning mode does not disable
required Local Memory MCP reads and writes. It forbids project/external state
changes, not durable working memory, unless the user explicitly forbids memory
writes for that task.

When the user says "remember", "запомни", "save this", or "зафиксируй", write
memory immediately with `remember_fact`, `remember_decision`, or `remember`.

When a fact is stale or wrong, use `correct`. When memory is irrelevant, use
`forget`. When many stale memories create noise, use `batch_forget`.

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
`get_memory_stats`, `get_repository_overview`, `list_repositories`, and
`get_task_memory`.

Useful write tools: `remember`, `remember_fact`, `remember_decision`,
`correct`, `forget`, `batch_forget`, `link_memories`,
`set_session_context`, `open_task_memory`, `update_task_memory`,
`close_task_memory`, and `digest_session`.

Never store secrets, tokens, passwords, private keys, credentials, or private
auth material.

Current user instructions and current repository files beat old memory.
<!-- END LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
```

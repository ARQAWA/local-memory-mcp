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
- Verify SQLite, MCP tools, project-memory tools, and installed rules.

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

Rules:
- Do not create `.env`, `.env.local`, or `.env.example`.
- Use global system environment variables only.
- Do not clone into an application repository.
- Use `LOCAL_MEMORY_DB_PATH` only when the default database path must change.
- Use `OPENROUTER_API_KEY` for embeddings.
- Use `LOCAL_MEMORY_RERANKER=none|command` and
  `LOCAL_MEMORY_RERANKER_CMD` only when a local reranker is explicitly needed.
- Use `LOCAL_MEMORY_LIBRARIAN_MODE=off|auto|always`,
  `LOCAL_MEMORY_LIBRARIAN_CMD`, and
  `LOCAL_MEMORY_LIBRARIAN_TIMEOUT_MS=30000` only when a local librarian
  command is explicitly needed.
- Do not print secret values.

Steps:
1. Detect the current agent host.
2. Install or update the repo at the install path.
   - If this prompt is in an already checked-out repo, use that repo/ref as
     the source.
   - Do not assume GitHub `main` contains local uncommitted work unless the
     user explicitly says to install from GitHub.
   - Remove stale files from the install path before copying/building.
3. Install dependencies with `pnpm install --frozen-lockfile`.
4. Run `pnpm exec tsc --noEmit --incremental false`.
5. Run `pnpm exec eslint src tests --max-warnings=0`.
6. Run `pnpm test`.
7. Build with `pnpm run build`.
8. Run migrations with `pnpm run migrate`.
9. Link command wrappers into `$HOME/.local/bin`.
10. Configure a global MCP server named `local-memory`.
    - For Codex, set `required = true` for `mcp_servers.local-memory`.
11. Install the managed contract below into the host global rules.
    - Replace only the managed `LOCAL_MEMORY_MCP_AGENT_CONTRACT` block.
    - Preserve unrelated rules and other managed blocks, including ARQAWA
      blocks.
12. Start a fresh agent/MCP session and verify tool schemas.

Install checks:
- `dist` must be freshly built after `rm -rf dist`.
- The database file must exist after migrations.
- Existing repository rows must have non-null `root_path`, SHA-256 `root_hash`,
  and object metadata with `identity_kind`.
- The database must have `card_type`, `status`, `source_type`, `confidence`,
  `anchors_json`, `metadata_json`, and `supersedes_id` on `memories`.
- Migration must create a SQLite backup before pending migrations.
- There must be no browser UI, admin UI, or web route surface in the active
  build.
- MCP schemas must expose only repository-first selector fields.
- MCP schemas must expose project-memory tools:
  `prepare_context`, `commit_task`, `correct_memory`.
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
`prepare_context(auto)` with the current task. Use `prepare_context(light)` for
micro-details. Use `recall` or `get_context_for` only when direct legacy memory
records are needed.

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
- Use `prepare_context(auto)` before non-trivial work.
- Use `prepare_context(light)` for micro-details and narrow follow-up facts.
- `prepare_context(auto)` must use deep retrieval for auth, security, billing,
  migration, architecture, debugging, and refactoring tasks.
- Use `recall` or `get_context_for` only when you need direct memory records or
  compatibility with older workflows.
- During analysis, write durable findings as soon as they become useful for
  future work.
- Before writing a new memory, search existing memory to avoid duplicates.
- At the end of a task, use `commit_task` for durable decisions, constraints,
  processes, gotchas, and roadmap items. Empty fields are not written.
- Prefer short, atomic project memory cards. Keep legacy `memory_type`
  compatible, but use card types: `decision`, `process`, `constraint`,
  `architecture`, `legacy`, `gotcha`, `roadmap`, `preference`, `task_state`,
  `reference`, or `fact`.
- Never write secrets, tokens, passwords, private keys, credentials, or private
  auth material.
- Do not store agent guesses as `current` truth. Use `candidate` or
  `needs_review`, or do not store the card.
- For broad audits, refactors, migrations, removals, agent-instruction changes,
  or architecture research, maintain a coverage map in memory: goal, acceptance
  criteria, aliases, searched commands, checked files or zones, positive
  findings, negative findings, remaining risks, and proof.
- At the end of important work, close Task Working Memory with
  `close_task_memory`. Use `digest_session` only when no task workbench is open
  and a separate session-level digest is needed.

Task Working Memory Protocol:

For any task that needs discovery, planning, edits, tests, review, or more than
one meaningful step, the agent must keep a short-lived task workbench.

1. Start with `get_active_context`.
2. Call `prepare_context(auto)` for the task topic, or
   `prepare_context(light)` for a micro-detail.
3. Open the workbench with `open_task_memory`.
   This creates only short-lived scratch. If the same slug is already open, it
   returns the existing scratch instead of overwriting it.
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
10. Before reporting done, call `close_task_memory`. It must delete or
    explicitly retain scratch, create one small task artifact with TTL, and
    promote durable knowledge only when `durable_summary` contains reusable
    knowledge.

Task memory has three layers:

- scratch: temporary planning, analysis, progress, proof, and review state;
- task artifact: one short-lived receipt after close, TTL 30 days by default or
  5 days when `task_kind=microtask`;
- durable knowledge: permanent memory only for reusable facts, decisions,
  procedures, conventions, architecture changes, API/contract changes, bug root
  causes, migrations, non-obvious repo patterns, or important negative findings.

Do not promote administrative task text, task slugs, routine progress, or
low-value microtask details into durable memory.

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

When a memory card is stale, wrong, deprecated, superseded, or uncertain, use
`correct_memory` to change its status. Use `correct` only when corrected text
must supersede old text. When memory is irrelevant, use `forget`. When many
stale memories create noise, use `batch_forget`.

Memory card status rules:

- `status` is more important than score.
- `wrong` must not be shown in prepared context.
- `deprecated` and `superseded` must appear only in the `Legacy` section.
- `current` can be used for verified durable truth.
- `candidate` and `needs_review` are for useful but uncertain findings.

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

Useful read tools: `get_active_context`, `prepare_context`, `recall`,
`get_context_for`,
`get_memory`, `get_related`, `get_group`, `list_memories`,
`search_memories`, `query_entities`, `detect_conflicts`,
`get_memory_stats`, `get_repository_overview`, `list_repositories`, and
`get_task_memory`.

Useful write tools: `remember`, `remember_fact`, `remember_decision`,
`commit_task`, `correct_memory`, `correct`, `forget`, `batch_forget`, `link_memories`,
`set_session_context`, `open_task_memory`, `update_task_memory`,
`close_task_memory`, and `digest_session`.

Never store secrets, tokens, passwords, private keys, credentials, or private
auth material.

Current user instructions and current repository files beat old memory.
<!-- END LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
```

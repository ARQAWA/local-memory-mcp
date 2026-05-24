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
- The Jina MLX reranker is mandatory. Do not install a fallback or none mode.
- `pnpm run setup:reranker` creates the local `.venv`, installs MLX Python
  dependencies, and downloads `jinaai/jina-reranker-v3-mlx`.
- Use `LOCAL_MEMORY_RERANKER_MODEL_PATH`,
  `LOCAL_MEMORY_RERANKER_PYTHON`, and
  `LOCAL_MEMORY_RERANKER_TIMEOUT_MS` only when defaults must change.
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
4. Run `pnpm run setup:reranker`.
5. Run `pnpm exec tsc --noEmit --incremental false`.
6. Run `pnpm exec eslint src tests --max-warnings=0`.
7. Run `pnpm test`.
8. Build with `pnpm run build`.
9. Run migrations with `node dist/db/migrate.js`.
10. Run `pnpm run doctor`.
11. Link command wrappers into `$HOME/.local/bin`.
12. Configure a global MCP server named `local-memory`.
    - For Codex, set `required = true` for `mcp_servers.local-memory`.
13. Install the managed contract below into the host global rules.
    - Replace only the managed `LOCAL_MEMORY_MCP_AGENT_CONTRACT` block.
    - Preserve unrelated rules and other managed blocks, including ARQAWA
      blocks.
14. Start a fresh agent/MCP session and verify tool schemas.

Install checks:
- `dist` must be freshly built after `rm -rf dist`.
- The database file must exist after migrations.
- Existing repository rows must have non-null `root_path`, SHA-256 `root_hash`,
  and object metadata with `identity_kind`.
- The database must have `card_type`, `status`, `source_type`, `confidence`,
  `anchors_json`, `metadata_json`, and `supersedes_id` on `memories`.
- Migration must create a SQLite backup before pending migrations.
- `pnpm run doctor` must pass.
- Doctor must verify macOS Apple Silicon, Python venv, MLX import, model path,
  and a sample rerank.
- The active build must expose the MCP stdio backend only.
- MCP schemas must expose only:
  `prepare_context`, `commit_task`, `correct_memory`.
- MCP schemas must not expose raw memory read, write, graph, or maintenance
  tools.
- The host global rules must contain exactly one
  `LOCAL_MEMORY_MCP_AGENT_CONTRACT` block.
- If ARQAWA blocks exist, they must remain separate and must not weaken,
  duplicate, or replace the Local Memory MCP contract.
- Codex config must mark `mcp_servers.local-memory` with `required = true`.
- A fresh agent session must expose Local Memory MCP before doing work.

Managed contract:

<!-- BEGIN LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
## Local Memory MCP Agent Contract

Local Memory MCP is the agent's project memory backend.

If this contract is present, Local Memory MCP is required. Do not treat missing
or unavailable memory tools as permission to continue without memory.

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

- Before a non-trivial task, call `prepare_context(auto)`.
- For micro-details and narrow follow-up facts, call `prepare_context(light)`.
- Work from the returned `context_pack`.
- Do not read raw memory records directly.
- Do not ask for or depend on hidden memory tools.
- At the end of a task, use `commit_task` for durable decisions, constraints,
  processes, gotchas, and roadmap items. Empty fields are not written.
- Use `correct_memory` when a memory card is stale, wrong, deprecated,
  superseded, uncertain, or restored to current.
- Prefer short, atomic project memory cards. Keep legacy `memory_type`
  compatible, but use card types: `decision`, `process`, `constraint`,
  `architecture`, `legacy`, `gotcha`, `roadmap`, `preference`, `task_state`,
  `reference`, or `fact`.
- Never write secrets, tokens, passwords, private keys, credentials, or private
  auth material.
- Do not store agent guesses as `current` truth. Use `candidate` or
  `needs_review`, or do not store the card.
- For broad audits, refactors, migrations, removals, agent-instruction
  changes, or architecture research, include durable coverage/proof findings in
  `commit_task` when they are reusable.

Memory-Controlled Completion Protocol for broad or high-stakes tasks:

1. Build a requirements traceability matrix from the user's strongest intent.
2. Use `prepare_context(auto)` before planning the work.
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
9. Use `commit_task` for reusable durable findings, decisions, constraints,
   gotchas, and remaining risks.
10. Do not report "done" until every in-scope requirement is covered or any
    remaining gap is explicitly reported as a blocker or risk.

Repository read-only, inspection, analysis, or planning mode still allows
`prepare_context` reads. It forbids project, product, external, or user-visible
state changes unless the user explicitly asks for them.

When the user says "remember", "запомни", "save this", or "зафиксируй", use
`commit_task` if the memory is reusable project knowledge. Do not write secrets
or unverified guesses.

Memory card status rules:

- `status` is more important than score.
- `wrong` must not be shown in prepared context.
- `deprecated` and `superseded` must appear only in the `Legacy` section.
- `current` can be used for verified durable truth.
- `candidate` and `needs_review` are for useful but uncertain findings.

Useful tools:

- `prepare_context`
- `commit_task`
- `correct_memory`

Never store secrets, tokens, passwords, private keys, credentials, or private
auth material.

Current user instructions and current repository files beat old memory.
<!-- END LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
```

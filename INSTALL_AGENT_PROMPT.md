# Install Agent Prompt

Use this prompt with an AI coding agent on the target machine.

```text
You are installing Local Memory MCP.

Goal:
- Install one shared Local Memory MCP on this machine.
- Use one local SQLite database file.
- Configure the current agent host to use this MCP proxy globally.
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
- MCP stdio is a proxy connector only.
- `memoryd` is the singleton backend for this user and host.
- Only `memoryd` opens SQLite, retrieval runtime, and the Qwen3 GGUF
  llama.cpp reranker.
- Multiple clients and MCP sessions share one `memoryd`.
- Topology: many MCP sessions -> one `memoryd` -> one Qwen3 llama.cpp runtime.
- There is no per-MCP model load.
- Public MCP tools are only `prepare_context`, `commit_task`, and
  `correct_memory`.
- Backend-boundary command hooks are internal dev/debug support only. They are
  not normal subagent UX and are not native client subagent proof.

Backend state files:
- `$HOME/.local/share/local-memory-mcp/memoryd.sock`
- `$HOME/.local/share/local-memory-mcp/memoryd.pid`
- `$HOME/.local/share/local-memory-mcp/memoryd.lock`
- `$HOME/.local/share/local-memory-mcp/memoryd.log`

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
- Do not change the host agent personality, tone, style rules, or ARQAWA
  rules. Install or replace only the managed Local Memory MCP contract block.
- Use `LOCAL_MEMORY_DB_PATH` only when the default database path must change.
- Use `OPENROUTER_API_KEY` for embeddings.
- The Qwen3 GGUF llama.cpp reranker is mandatory. Do not install a fallback or
  none mode.
- `pnpm run setup:reranker` finds or installs `llama.cpp` / `llama-server`,
  downloads `Qwen3-Reranker-0.6B.Q4_K_M.gguf`, verifies the GGUF file, runs a
  sample rerank, and saves the local reranker profile.
- Use `LOCAL_MEMORY_RERANKER_MODEL_PATH`,
  `LOCAL_MEMORY_LLAMA_SERVER_BIN`, and
  `LOCAL_MEMORY_RERANKER_TIMEOUT_MS` only when defaults must change.
- Do not configure backend command hooks as normal client subagents.
- Do not print secret values.

Steps:
1. Detect the current agent host.
2. Detect the active app path and active command path.
   - Default app path: `$HOME/.local/share/local-memory-mcp/app`.
   - Default command: `$HOME/.local/bin/local-memory-mcp`.
3. Remove stale files that are not present in the current repo during active
   app sync.
   - Do not restart removed legacy services.
   - Do not restore removed public tools.
4. Back up the live SQLite DB before changing the active app.
   - Use `VACUUM INTO` to create a backup under
     `$HOME/.local/share/local-memory-mcp/backups`.
   - Do not continue if the backup fails.
5. Download or update the repo, then sync repo -> active app.
   - Repository URL: `https://github.com/ARQAWA/local-memory-mcp`.
   - If this prompt is run inside an already checked-out repo, use that
     checkout/ref as the source.
   - If no source checkout exists, clone the repository.
   - If a source checkout exists, fetch and update it to the requested branch
     or ref. If no ref is requested, use the checkout's current branch.
   - Do not assume GitHub `main` contains local uncommitted work unless the
     user explicitly says to install from GitHub.
   - Sync the source into `$HOME/.local/share/local-memory-mcp/app`.
   - Delete stale active-app files during sync, while preserving live DB,
     backups, and user/global secret config outside the app path.
6. Install dependencies with `pnpm install --frozen-lockfile`.
7. Run `pnpm run setup:reranker`.
8. Run `pnpm exec tsc --noEmit --incremental false`.
9. Run `pnpm exec eslint src tests --max-warnings=0`.
10. Run `pnpm test`.
11. Build with `pnpm run build`.
12. Run migrations with `node dist/db/migrate.js`.
13. Run `pnpm run doctor`.
14. Run `pnpm run smoke:mcp-session`.
15. Run `pnpm run smoke:librarian-modes`.
16. Run `pnpm run smoke:singleton`.
17. Run `pnpm run smoke:reranker-memory`.
18. Link command wrappers into `$HOME/.local/bin`.
19. Configure a global MCP server named `local-memory`.
    - For Codex, set `required = true` for `mcp_servers.local-memory`.
20. Install the managed contract below into the host global rules.
    - Replace only the managed `LOCAL_MEMORY_MCP_AGENT_CONTRACT` block.
    - Preserve unrelated rules and other managed blocks, including ARQAWA
      blocks.
21. Configure native memory-librarian setup for the client profile when the
    client supports native subagents.
22. Start a fresh agent/MCP session and verify tool schemas and the expected
    route: `prepare_context(auto)` -> work -> `prepare_context(light)` ->
    `commit_task`.

Client-specific short instructions:

The sections below are self-contained. `INSTALL_PROFILES.md` is the concise
reference after the proxy/backend install is complete.

Codex:
- Configure `~/.codex/config.toml` with `mcp_servers.local-memory`.
- Use command `$HOME/.local/bin/local-memory-mcp`.
- Set `required = true`.
- Install the managed contract into `~/.codex/AGENTS.md`.
- If this Codex install supports native subagents, create a native
  `memory-librarian` subagent/profile.
- Give the native librarian access to the same required `local-memory` MCP
  server.
- Limit the librarian instruction to memory retrieval using the managed memory
  contract.
- Expected native route:
  `Codex main agent -> Codex native memory-librarian -> prepare_context(deep)`.
- The main agent still uses `prepare_context(light)` for narrow follow-up facts
  and `commit_task` at task end.
- Do not use backend command hook smoke as proof of Codex native subagent
  behavior.

Claude Code:
- Add the MCP server at user scope:
  `claude mcp add local-memory --scope user -- $HOME/.local/bin/local-memory-mcp`.
- Install a separate Claude memory contract in the Claude Code user/global
  instruction target.
- Configure a Claude Code native `memory-librarian` subagent when available.
- Allow it to inherit configured MCP tools.
- Expected native route:
  `main agent -> memory-librarian -> prepare_context(deep)`.
- Do not mark Claude Code verification complete unless it was tested on this
  host.

Cursor:
- Configure `~/.cursor/mcp.json` for global use, or `.cursor/mcp.json` for a
  project-local setup.
- Add `local-memory` with command `$HOME/.local/bin/local-memory-mcp`.
- Install the managed contract into Cursor User Rules or project rules.
- Configure a native `memory-librarian` agent/rule setup when the installed
  Cursor version supports it.
- Expected native route:
  `main agent -> memory-librarian -> prepare_context(deep)`.

GitHub Copilot / VS Code:
- For VS Code, configure the user or workspace `mcp.json`, or use
  `code --add-mcp`.
- For Copilot CLI, use `/mcp add` or edit `~/.copilot/mcp-config.json`.
- Add only the `local-memory` stdio server command and the managed contract in
  the client instruction location.
- Configure native Copilot/VS Code agent mode as `memory-librarian` when
  available.
- Expected native route:
  `main agent -> memory-librarian -> prepare_context(deep)`.

Install checks:
- `dist` must be freshly built after `rm -rf dist`.
- The database file must exist after migrations.
- Existing repository rows must have non-null `root_path`, SHA-256 `root_hash`,
  and object metadata with `identity_kind`.
- The database must have `card_type`, `status`, `source_type`, `confidence`,
  `anchors_json`, `metadata_json`, and `supersedes_id` on `memories`.
- Migration must create a SQLite backup before pending migrations.
- `pnpm run doctor` must pass.
- Doctor must verify `llama-server`, Qwen3 GGUF model path, one `memoryd`, one
  llama.cpp runtime inside `memoryd`, and a sample rerank result.
- `pnpm run smoke:singleton` must prove 3 MCP stdio sessions -> 1 memoryd ->
  1 Qwen3 llama.cpp runtime.
- `pnpm run smoke:reranker-memory` must prove the same singleton route and
  fail a 7 GB memory regression.
- The active build must expose MCP stdio proxy only.
- `memoryd` must be the only backend process.
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
- Fresh-session behavior verification must test the agent route itself:
  `prepare_context(auto)` -> work -> `prepare_context(light)` -> `commit_task`.
- The first `prepare_context(auto)` call must be agent-initiated before the
  plan or implementation, not manually requested as a tool smoke test.
- The light-mode check must be a narrow follow-up inside the same task.
- The commit check must prove the agent uses `commit_task`, not removed raw
  memory tools.
- Native librarian verification must use the client's native subagent trace
  when the client exposes one.
- If the client cannot expose objective native-subagent trace, record
  `not objectively provable`.
- Do not replace native client proof with backend command hook smoke.
- `pnpm run smoke:mcp-session` verifies a fresh stdio MCP session exposes only
  the public tools and checks the internal dev/debug librarian command path.
- `pnpm run smoke:librarian-modes` verifies `off`, `auto`, and `always`
  internal librarian mode behavior.
- `pnpm run smoke:singleton` verifies multiple MCP sessions share one
  `memoryd` and one Qwen3 llama.cpp runtime.
- `pnpm run smoke:reranker-memory` verifies best-effort reranker RAM and idle
  unload behavior.

Managed contract:

<!-- BEGIN LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
## Local Memory MCP Agent Contract

Local Memory MCP is the agent's proxy to project memory.

If this contract is present, Local Memory MCP is required. Do not treat missing
or unavailable memory tools as permission to continue without memory.

Without Local Memory MCP, stop and report the blocker. Do not continue without
memory and do not invent memory results. The only exception is work whose direct
goal is to install, configure, or repair Local Memory MCP itself.

One machine has one shared Local Memory MCP proxy, one singleton `memoryd`
backend, and one shared local SQLite database file. Do not create per-agent or
per-repository databases.

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

When the user asks to save reusable project knowledge, use `commit_task`.
Do not write secrets or unverified guesses.

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

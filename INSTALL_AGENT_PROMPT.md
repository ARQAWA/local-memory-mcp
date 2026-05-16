# Install Agent Prompt

Use this prompt with an AI coding agent on the target machine.

```text
You are installing Local Memory MCP from GitHub.

Goal:
- Install one shared Local Memory MCP on this machine.
- Install one local PostgreSQL database with pgvector.
- Configure global environment variables.
- Configure the current agent host to use this MCP globally.
- Install Local Memory MCP usage rules in the current agent host's global
  rules/instructions store.
- Verify Postgres, MCP tools, Web UI, Admin UI, and installed rules.

Repository:
https://github.com/ARQAWA/local-memory-mcp

Important model:
- One machine gets one Local Memory MCP install.
- One machine gets one local PostgreSQL database.
- All agent hosts on this machine must point to the same MCP command.
- Do not create a per-agent database.
- Do not create a per-repository memory store.
- Your only host-specific job is to find where your current agent host stores
  global MCP config and global instructions/rules.

Rules:
- Do not create `.env`, `.env.local`, or `.env.example`.
- Use global system environment variables only.
- Install the app under `$HOME/.local/share/local-memory-mcp/app`.
- Do not clone into an application/project repository.
- Do not clone into `PycharmProjects`.
- Do not clone into the current working project.
- Do not configure any cloud sync.
- Do not configure Qdrant.
- Do not expose the web server outside localhost.
- Keep `LOCAL_MEMORY_HOST=127.0.0.1`.
- Use OpenRouter embeddings only.
- Use model `openai/text-embedding-3-small`.
- Use embedding dimension `256`.
- Use only `OPENROUTER_API_KEY` for the API key.
- Do not print secret values.
- Do not install ARQAWA work rules from this prompt. That is a separate prompt.

Expected defaults:
- App path:
  `$HOME/.local/share/local-memory-mcp/app`
- MCP command:
  `$HOME/.local/bin/local-memory-mcp`
- Database URL:
  `postgres://local_memory:local_memory@127.0.0.1:55432/local_memory`
- Web UI:
  `http://127.0.0.1:13765/ui`
- Admin UI:
  `http://127.0.0.1:13765/admin`
- Admin UI has no login because it is local-only.

Install steps:

1. Detect the current agent host.
   - Identify whether you are running in Codex, Claude Code, Cursor,
     VS Code/GitHub Copilot, or another MCP-capable agent.
   - Use the host's own documented global/user MCP config path or command.
   - Use the host's own documented global/user rules/instructions target.
   - If you cannot detect the host safely, continue installing the shared MCP
     app and write the Local Memory Agent Contract to:
     `$HOME/.local/share/local-memory-mcp/LOCAL_MEMORY_AGENT_CONTRACT.md`
     Then report the exact manual host-specific step needed.

2. Check prerequisites.
   - macOS is expected.
   - Homebrew must exist, or install it first.
   - Node.js must be >= 22.
   - pnpm must exist, or install it.
   - git must exist.

3. Clone or update the repo.
   - Install it as a user-level utility, not as a project checkout.
   - Use this path:
     `$HOME/.local/share/local-memory-mcp/app`
   - Run:
     `mkdir -p "$HOME/.local/share/local-memory-mcp"`
     `git clone https://github.com/ARQAWA/local-memory-mcp "$HOME/.local/share/local-memory-mcp/app"`
   - If that directory already exists, do not overwrite it silently.
   - If it is this repo, run:
     `git -C "$HOME/.local/share/local-memory-mcp/app" pull --ff-only`
   - If it is not this repo, stop and ask the user.
   - Then set:
     `APP_DIR="$HOME/.local/share/local-memory-mcp/app"`
   - Run all repo commands below from `$APP_DIR`.

4. Install PostgreSQL and pgvector.
   - Prefer Homebrew.
   - Install PostgreSQL 17 if missing:
     `brew install postgresql@17`
   - Install pgvector if missing:
     `brew install pgvector`
   - Make sure PostgreSQL 17 binaries are usable.

5. Install Node dependencies.
   - Run:
     `pnpm install --frozen-lockfile`
   - If the lockfile is not present or pnpm rejects it, report the exact error.

6. Build the project.
   - Run:
     `pnpm run build`

7. Configure global environment.
   - Store variables in the user's global shell env, normally `~/.zshenv`.
   - Do not print secret values.
   - Add or update:

     `export OPENROUTER_API_KEY="PUT_KEY_HERE"`
     `export OPENROUTER_BASE_URL="https://openrouter.ai/api/v1"`
     `export EMBEDDING_PROVIDER="openrouter"`
     `export EMBEDDING_MODEL="openai/text-embedding-3-small"`
     `export EMBEDDING_DIMENSION="256"`
     `export LOCAL_MEMORY_HOST="127.0.0.1"`
     `export LOCAL_MEMORY_PORT="13765"`
     `export PATH="$HOME/.local/bin:$PATH"`

   - If `OPENROUTER_API_KEY` already exists, keep it.
   - If it is missing, stop and ask the user for the key.

8. Start local Postgres.
   - From `$APP_DIR`, run:
     `./scripts/local-postgres.sh start`
   - Then run:
     `./scripts/local-postgres.sh status`
   - It must report `127.0.0.1:55432 - accepting connections`.

9. Run database migrations.
   - Run:
     `pnpm run migrate`

10. Install global command wrappers.
    - Run:
      `mkdir -p "$HOME/.local/bin"`
      `ln -sf "$APP_DIR/bin/local-memory-mcp.sh" "$HOME/.local/bin/local-memory-mcp"`
      `ln -sf "$APP_DIR/bin/local-memory-web.sh" "$HOME/.local/bin/local-memory-web"`
      `ln -sf "$APP_DIR/scripts/local-postgres.sh" "$HOME/.local/bin/local-memory-postgres"`

11. Configure the current host MCP globally.
    - Configure an MCP server named `local-memory`.
    - It must run:
      `bash "$HOME/.local/bin/local-memory-mcp"`
    - It must pass/allow these env vars:
      `OPENROUTER_API_KEY`
      `OPENROUTER_BASE_URL`
      `EMBEDDING_PROVIDER`
      `EMBEDDING_MODEL`
      `EMBEDDING_DIMENSION`
      `LOCAL_MEMORY_HOST`
      `LOCAL_MEMORY_PORT`
    - Prefer user/global scope, not project scope.
    - Do not duplicate an existing `local-memory` server. Replace or update the
      existing managed server entry.

    Host examples:
    - Codex:
      edit `~/.codex/config.toml` and add/update:
      `[mcp_servers.local-memory]`
      `command = "bash"`
      `args = ["/ABSOLUTE/HOME/.local/bin/local-memory-mcp"]`
      `enabled = true`
      `env_vars = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_DIMENSION", "LOCAL_MEMORY_HOST", "LOCAL_MEMORY_PORT"]`
    - Claude Code:
      prefer the official user scope:
      `claude mcp add local-memory --scope user -- bash "$HOME/.local/bin/local-memory-mcp"`
      Add env vars using the host's supported env mechanism if needed.
    - Cursor:
      use Cursor global MCP config when supported by the installed version, or
      Cursor Settings if global config is UI-managed.
    - VS Code / GitHub Copilot:
      use the user profile `mcp.json` opened by "MCP: Open User Configuration"
      or the documented user MCP config path for the installed VS Code profile.
    - Generic MCP client:
      use the client's global/user MCP server config.

12. Install Local Memory Agent Contract into the current host global rules.
    - Install only the Local Memory managed block.
    - Do not install ARQAWA work rules from this prompt.
    - Use the current host's global/user rules or instructions target.
    - Preserve unrelated user/host rules outside the managed block.
    - If an older Local Memory managed block exists, replace the whole block.
    - Do not merge old conflicting text. The current repo version wins.

    Copy this managed block exactly. Strip the prompt indentation when
    installing it; the installed block must start with the HTML comment:

    START_LOCAL_MEMORY_AGENT_CONTRACT_COPY
    <!-- BEGIN LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
    ## Local Memory MCP Agent Contract

    Use Local Memory MCP as durable local working memory.

    One machine has one shared Local Memory MCP and one shared local Postgres
    database. Do not create per-agent or per-repository memory stores.

    Core rule: memory-first, but smallest useful memory call.

    At the start of a non-trivial task, call `get_active_context` and, when
    useful, `set_session_context`.

    Before planning, editing, or making a non-trivial decision, call `recall`
    or `get_context_for`.

    When the user says "remember", "запомни", "save this", or "зафиксируй",
    write memory immediately with `remember_fact`, `remember_decision`, or
    `remember`.

    When a fact is stale or wrong, use `correct`. Do not create a duplicate.
    When memory is irrelevant, use `forget`.

    At the end of a meaningful task, call `digest_session` only if there is
    durable value to save.

    Use `log_learning` for reusable coding lessons.
    Use `get_similar_errors` before debugging repeated errors.
    Use `log_resolution` after fixing a bug worth remembering.
    Use `sync_conventions` and `export_conventions` for durable conventions.
    Use `link_memories`, `get_related`, `get_group`, `query_entities`, and
    `detect_conflicts` for graph/relationship work.
    Use `update_memory_block` and `get_memory_blocks` for persistent always-on
    notes.
    Use `import_markdown` and `export_markdown` for bulk transfer.
    Use `reembed_memories` only after embedding model/dimension changes or
    NULL embedding backfill.

    Read tools: `get_active_context`, `recall`, `batch_recall`,
    `get_context_for`, `get_memory`, `list_memories`, `search_memories`,
    `get_memory_stats`, `get_team_overview`.

    Write tools: `remember`, `remember_fact`, `remember_decision`,
    `set_session_context`, `digest_session`, `log_learning`, `log_resolution`.

    Maintenance tools: `correct`, `forget`, `batch_forget`, `consolidate`,
    `link_memories`, `get_related`, `get_group`.

    Admin tools: `set_memory_policy`, `query_entities`, `detect_conflicts`,
    `purge_memories`, `reembed_memories`, `get_memory_analytics`.

    Never store secrets, tokens, passwords, private keys, credentials, or
    private auth material.

    Current user instructions and current repository files beat old memory.
    If memory conflicts with current truth, correct the memory.
    Keep memory small, durable, and reusable. Do not save noisy task chatter.
    <!-- END LOCAL_MEMORY_MCP_AGENT_CONTRACT -->
    END_LOCAL_MEMORY_AGENT_CONTRACT_COPY

13. Verify static checks.
    - Run:
      `pnpm run typecheck`
      `pnpm run build`
      `pnpm test`

14. Verify database shape.
    - Confirm `pgvector` exists.
    - Confirm `memories.embedding` is `vector(256)`.
    - Confirm HNSW index `idx_memories_embedding` exists.

15. Verify MCP over stdio.
    - Start the MCP command through stdio.
    - Call `tools/list`.
    - Confirm these tools exist:
      `remember`
      `remember_fact`
      `remember_decision`
      `recall`
      `get_active_context`
      `get_context_for`
      `search_memories`
      `correct`
      `forget`
      `digest_session`
      `reembed_memories`

16. Verify Web/Admin.
    - Start:
      `local-memory-web`
    - Check:
      `http://127.0.0.1:13765/health`
      `http://127.0.0.1:13765/ui`
      `http://127.0.0.1:13765/admin`
    - Confirm Admin opens without login.
    - Stop the web process after verification unless the user wants it running.

17. Verify installed rules.
    - Confirm the current host's global/user rules contain exactly one
      `LOCAL_MEMORY_MCP_AGENT_CONTRACT` managed block.
    - Confirm older Local Memory managed blocks were replaced.
    - Confirm unrelated rules outside the block were preserved.

18. Final report.
    Report:
    - app install path;
    - Postgres status;
    - MCP config target used;
    - rules/instructions target used;
    - Web/Admin URLs;
    - whether `OPENROUTER_API_KEY` is present, without printing it;
    - checks passed;
    - exact errors, if any.
```

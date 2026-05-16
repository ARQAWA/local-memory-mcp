# Install Agent Prompt

Use this prompt with an AI coding agent on the target machine.

```text
You are installing Local Memory MCP from GitHub.

Goal:
- Clone the repository.
- Install dependencies.
- Install and start local PostgreSQL with pgvector.
- Configure global environment variables.
- Configure Codex MCP globally.
- Verify MCP, Postgres, Web UI, and Admin UI.

Repository:
https://github.com/ARQAWA/local-memory-mcp

Rules:
- Do not create `.env`, `.env.local`, or `.env.example`.
- Use global system environment variables only.
- Do not configure any cloud sync.
- Do not configure Qdrant.
- Do not expose the web server outside localhost.
- Keep `LOCAL_MEMORY_HOST=127.0.0.1`.
- Use OpenRouter embeddings only.
- Use model `openai/text-embedding-3-small`.
- Use embedding dimension `256`.
- Use only `OPENROUTER_API_KEY` for the API key.

Expected defaults:
- Database URL:
  `postgres://local_memory:local_memory@127.0.0.1:55432/local_memory`
- Web UI:
  `http://127.0.0.1:13765/ui`
- Admin UI:
  `http://127.0.0.1:13765/admin`
- Admin UI has no login because it is local-only.

Install steps:

1. Check prerequisites.
   - macOS is expected.
   - Homebrew must exist, or install it first.
   - Node.js must be >= 22.
   - pnpm must exist, or install it.
   - git must exist.

2. Clone the repo.
   - Clone `https://github.com/ARQAWA/local-memory-mcp` into a stable user project folder.
   - Example:
     `~/PycharmProjects/local-memory-mcp`

3. Install PostgreSQL and pgvector.
   - Prefer Homebrew.
   - Install PostgreSQL 17 if missing:
     `brew install postgresql@17`
   - Install pgvector if missing:
     `brew install pgvector`
   - Make sure PostgreSQL 17 binaries are usable.

4. Install Node dependencies.
   - Run:
     `pnpm install --frozen-lockfile`
   - If the lockfile is not present or pnpm rejects it, report the exact error.

5. Build the project.
   - Run:
     `pnpm run build`

6. Configure global environment.
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

7. Start local Postgres.
   - From the repo root, run:
     `./scripts/local-postgres.sh start`
   - Then run:
     `./scripts/local-postgres.sh status`
   - It must report `127.0.0.1:55432 - accepting connections`.

8. Run database migrations.
   - Run:
     `pnpm run migrate`

9. Install global command wrappers.
   - Run:
     `mkdir -p "$HOME/.local/bin"`
     `ln -sf "$REPO_ROOT/bin/local-memory-mcp.sh" "$HOME/.local/bin/local-memory-mcp"`
     `ln -sf "$REPO_ROOT/bin/local-memory-web.sh" "$HOME/.local/bin/local-memory-web"`
     `ln -sf "$REPO_ROOT/scripts/local-postgres.sh" "$HOME/.local/bin/local-memory-postgres"`
   - Replace `$REPO_ROOT` with the absolute repo path.

10. Configure Codex MCP.
    - Edit `~/.codex/config.toml`.
    - Add or update this block.
    - Use the absolute path for the current user:

      `[mcp_servers.local-memory]`
      `command = "bash"`
      `args = ["/ABSOLUTE/HOME/.local/bin/local-memory-mcp"]`
      `enabled = true`
      `env_vars = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "EMBEDDING_DIMENSION", "LOCAL_MEMORY_HOST", "LOCAL_MEMORY_PORT"]`

    - Do not duplicate the block if it already exists.

11. Verify static checks.
    - Run:
      `pnpm run typecheck`
      `pnpm run build`
      `pnpm test`

12. Verify database shape.
    - Confirm `pgvector` exists.
    - Confirm `memories.embedding` is `vector(256)`.
    - Confirm HNSW index `idx_memories_embedding` exists.

13. Verify MCP over stdio.
    - Start the MCP command through stdio.
    - Call `tools/list`.
    - Confirm tools like `remember` and `recall` exist.

14. Verify Web/Admin.
    - Start:
      `local-memory-web`
    - Check:
      `http://127.0.0.1:13765/health`
      `http://127.0.0.1:13765/ui`
      `http://127.0.0.1:13765/admin`
    - Confirm Admin opens without login.
    - Stop the web process after verification unless the user wants it running.

15. Final report.
    Report:
    - repo path;
    - Postgres status;
    - MCP config path;
    - Web/Admin URLs;
    - whether `OPENROUTER_API_KEY` is present, without printing it;
    - checks passed;
    - exact errors, if any.
```

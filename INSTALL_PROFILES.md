# Local Memory MCP Install Profiles

Short client profiles for a completed Local Memory MCP install.

Architecture:

- MCP stdio is a proxy connector only.
- `memoryd` is the singleton backend for one user and host.
- memoryd is the singleton backend.
- SQLite, retrieval, and Jina live only inside `memoryd`.
- Multiple clients and MCP sessions share the same backend.
- There is no per-MCP model load.

Shared MCP command:

```bash
$HOME/.local/bin/local-memory-mcp
```

Backend state files:

- `$HOME/.local/share/local-memory-mcp/memoryd.sock`
- `$HOME/.local/share/local-memory-mcp/memoryd.pid`
- `$HOME/.local/share/local-memory-mcp/memoryd.lock`
- `$HOME/.local/share/local-memory-mcp/memoryd.log`

Required environment:

- `OPENROUTER_API_KEY` for embeddings.
- `LOCAL_MEMORY_DB_PATH` only when the default DB path must change.
- `LOCAL_MEMORY_RERANKER_MODEL_PATH` only when the model is not in the
  default path.
- `LOCAL_MEMORY_RERANKER_PYTHON` only when the Python venv is not in the
  default app path.
- `LOCAL_MEMORY_LIBRARIAN_MODE`, `LOCAL_MEMORY_LIBRARIAN_CMD`, and
  `LOCAL_MEMORY_LIBRARIAN_TIMEOUT_MS` only when a backend command librarian is
  intentionally used.

Do not put secrets in project files. Prefer user/global environment config.

Expected fresh-session route:

```text
prepare_context(auto) -> work -> prepare_context(light) -> commit_task
```

Prompts and rules must add only the memory contract. They must not change the
client's personality, tone, or ARQAWA rules.

## Codex

Config targets:

- `~/.codex/config.toml`
- `~/.codex/AGENTS.md`

MCP command:

```toml
[mcp_servers.local-memory]
command = "bash"
args = ["-lc", "$HOME/.local/bin/local-memory-mcp"]
required = true
```

Env vars:

- Put shared env in the shell/profile that starts Codex.
- Keep `OPENROUTER_API_KEY` out of project files.

Native memory-librarian:

- Create a Codex native subagent named `memory-librarian` only if the host
  supports native subagents.
- Give it access to the same `local-memory` MCP tools.
- Its instruction is only the memory contract and retrieval route.
- It must not replace Codex personality, tone, or ARQAWA rules.

Verify fresh session:

```bash
codex mcp list
pnpm run smoke:mcp-session
pnpm run smoke:librarian-modes
pnpm run smoke:singleton
```

Then start a new Codex session and verify:

- visible tools: `prepare_context`, `commit_task`, `correct_memory`;
- first non-trivial action calls `prepare_context(auto)`;
- narrow follow-up calls `prepare_context(light)`;
- task closure calls `commit_task`.

## Claude Code

MCP command:

```bash
claude mcp add local-memory --scope user -- $HOME/.local/bin/local-memory-mcp
```

Env vars:

- Put shared env in the shell/profile that starts Claude Code.
- Keep secrets out of project files.

Native memory-librarian:

- Create a Claude Code native subagent named `memory-librarian`.
- Allow it to inherit configured MCP tools.
- Claude Code native memory-librarian inherits MCP tools by default.
- Its job is memory retrieval/commit workflow only.
- Do not use it as proof unless a real fresh Claude Code session was tested.

Verify fresh session:

```bash
claude mcp list
pnpm run smoke:mcp-session
pnpm run smoke:librarian-modes
pnpm run smoke:singleton
```

Expected route:

- `prepare_context(auto)` before planning or implementation;
- `prepare_context(light)` for narrow follow-up facts;
- `commit_task` at task end for durable reusable findings.

## Cursor

MCP command:

```json
{
  "mcpServers": {
    "local-memory": {
      "type": "stdio",
      "command": "/Users/arkadijcukavin/.local/bin/local-memory-mcp"
    }
  }
}
```

Config targets:

- `~/.cursor/mcp.json` for global use.
- `.cursor/mcp.json` only for intentional project-local setup.
- Cursor User Rules or project rules for the memory contract.

Env vars:

- Use Cursor user/global environment support or the shell that starts Cursor.
- Do not store secrets in `.cursor` project files.

Native memory-librarian:

- Create a Cursor native agent/rule setup named `memory-librarian` if the
  installed Cursor version supports it.
- Connect it to the configured `local-memory` MCP server.
- Keep its prompt limited to memory contract behavior.

Verify fresh session:

```bash
cursor-agent mcp list
cursor-agent mcp list-tools local-memory
pnpm run smoke:mcp-session
pnpm run smoke:librarian-modes
pnpm run smoke:singleton
```

Expected route:

- `prepare_context(auto)` -> work -> `prepare_context(light)` -> `commit_task`.

## VS Code / GitHub Copilot

VS Code MCP command:

```json
{
  "servers": {
    "local-memory": {
      "type": "stdio",
      "command": "/Users/arkadijcukavin/.local/bin/local-memory-mcp"
    }
  }
}
```

GitHub Copilot CLI command:

```bash
copilot mcp add local-memory -- $HOME/.local/bin/local-memory-mcp
```

Config targets:

- VS Code user MCP config or workspace `.vscode/mcp.json`.
- VS Code custom instructions for the memory contract.
- `~/.copilot/mcp-config.json` for Copilot CLI.
- Copilot instruction location for the memory contract.

Env vars:

- Use the user environment that starts VS Code/Copilot.
- Keep secrets out of workspace files.

Native memory-librarian:

- Use the native Copilot/VS Code agent mode if available.
- Name the setup `memory-librarian`.
- Give it access to `local-memory` MCP tools.
- Keep instructions limited to memory context and commit behavior.

Verify fresh session:

```bash
code --add-mcp
copilot mcp list
pnpm run smoke:mcp-session
pnpm run smoke:librarian-modes
pnpm run smoke:singleton
```

Expected route:

- `prepare_context(auto)` before work;
- `prepare_context(light)` for narrow follow-up facts;
- `commit_task` at task end.

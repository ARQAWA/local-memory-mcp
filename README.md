# Local Memory MCP

Local-only MCP memory server for AI coding agents.

It gives different agents on the same machine one shared durable memory:

- one user-level app install;
- one local PostgreSQL database;
- one `pgvector` vector index;
- one MCP command;
- one local Web/Admin viewer;
- host-specific agent rules only.

There is no cloud sync, no remote HTTP MCP endpoint, no Qdrant, no SQLite mode,
and no local `.env` contract. Runtime settings come from the global system
environment.

Default embeddings use OpenRouter with `openai/text-embedding-3-small` and
`256` dimensions.

Default local URLs:

- Web UI: `http://127.0.0.1:13765/ui`
- Admin UI: `http://127.0.0.1:13765/admin`

## Install Prompts

This repo contains two separate prompts.

| Prompt | Purpose |
|---|---|
| `INSTALL_AGENT_PROMPT.md` | Install Local Memory MCP and Local Memory usage rules. |
| `INSTALL_ARQAWA_WORK_GLOBAL_PROMPT.md` | Install ARQAWA global work rules only. |

They are intentionally separate.

`INSTALL_AGENT_PROMPT.md` does not install ARQAWA work rules.
`INSTALL_ARQAWA_WORK_GLOBAL_PROMPT.md` does not install Local Memory MCP.

## Shared Memory Model

Local Memory MCP is designed for many agents and many repositories.

The app is installed once under:

```text
$HOME/.local/share/local-memory-mcp/app
```

The database is shared across agents:

```text
postgres://local_memory:local_memory@127.0.0.1:55432/local_memory
```

Each agent host configures its own MCP connection and global instructions, but
all of them point to the same local MCP command:

```text
$HOME/.local/bin/local-memory-mcp
```

This means Codex, Claude Code, Cursor, VS Code/GitHub Copilot, and other MCP
clients can all use the same durable memory when configured on the same
machine.

## Local Memory Agent Contract

Agents should treat Local Memory MCP as durable local working memory.

The rule is:

```text
memory-first, but smallest useful memory call
```

Use memory when it helps the task. Do not call tools just to call tools.
Do not write low-value noise.

### Startup

At the start of a non-trivial task:

- call `get_active_context` with what you are working on;
- call `set_session_context` when the task will last more than a quick answer;
- use `recall` or `get_context_for` before planning or editing.

### Reads

| Situation | Preferred tools |
|---|---|
| General context | `get_active_context`, `recall` |
| Topic or file context | `get_context_for` |
| Several topics | `batch_recall` |
| Exact known memory | `get_memory` |
| Browsing recent memory | `list_memories`, `search_memories` |
| Related memories | `get_related`, `get_group` |
| Stats/overview | `get_memory_stats`, `get_team_overview` |

### Writes

| Situation | Preferred tools |
|---|---|
| User says "remember", "запомни", or "save this" | `remember_fact`, `remember_decision`, or `remember` |
| Architecture or product choice | `remember_decision` |
| Atomic fact | `remember_fact` |
| Useful coding lesson | `log_learning` |
| Bug fixed | `log_resolution` |
| End of meaningful task | `digest_session` only if durable value exists |

### Maintenance

| Situation | Preferred tools |
|---|---|
| Memory is stale or wrong | `correct` |
| Memory is irrelevant | `forget` |
| Many memories are irrelevant | `batch_forget` |
| Duplicate or fragmented memories | `consolidate` |
| Relationship is important | `link_memories` |
| Need reusable always-on note | `update_memory_block` |
| Need conventions | `sync_conventions`, `export_conventions` |
| Need import/export | `import_markdown`, `export_markdown` |

### Admin And Repair

Use admin tools carefully:

- `set_memory_policy`
- `query_entities`
- `detect_conflicts`
- `purge_memories`
- `reembed_memories`
- `get_memory_analytics`
- `get_similar_errors`

`reembed_memories` is for model or dimension changes, or for backfilling
missing embeddings. Normal writes do not need manual reindexing.

### Conflict Rules

- Current user instruction wins over old memory.
- Current repo files win over old memory.
- If memory conflicts with current facts, use `correct`.
- Never store secrets, tokens, private keys, passwords, or credentials.
- Prefer small durable facts over long chat transcripts.

## Host Rules

The install prompt is universal. The current agent must detect its host and
install the Local Memory managed instruction block in that host's global
rules/instructions location.

Known examples:

| Host | MCP config target | Instruction target |
|---|---|---|
| Codex | `~/.codex/config.toml` | `~/.codex/AGENTS.md` |
| Claude Code | `claude mcp add --scope user ...` | user/global Claude Code instructions |
| Cursor | global/user MCP config when supported | Cursor User Rules |
| VS Code / Copilot | user profile `mcp.json` | user/custom instructions or repo instructions |
| Generic MCP client | its global MCP config | its global instruction/rules store |

If the host cannot be detected safely, the installing agent should install the
MCP app and write the canonical Local Memory Agent Contract to the app
directory, then report the exact manual host-specific step.

## Drift Closure

Managed instruction blocks are canonical.

If an older Local Memory managed block exists, replace the whole block with the
current version from this repo.

Do not merge old conflicting text.
Do not edit unrelated user rules outside the managed block.

## Sources

- [Claude Code MCP docs](https://docs.claude.com/en/docs/claude-code/mcp)
- [Cursor rules docs](https://docs.cursor.com/en/context)
- [VS Code MCP configuration docs](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration)
- [GitHub Copilot custom instructions docs](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions)

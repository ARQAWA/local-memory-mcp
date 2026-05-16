# Local Memory MCP

Local-only MCP memory server for agents.

It stores durable memory in local PostgreSQL, uses `pgvector` for semantic
search, and keeps graph data for tags, entities, relations, memory blocks,
decisions, facts, procedures, sessions, imports, and exports.

There is no cloud sync, no remote HTTP MCP endpoint, no Qdrant, no SQLite mode,
and no local `.env` contract. Runtime settings come from the global system
environment.

Default embeddings use OpenRouter with `openai/text-embedding-3-small` and
`256` dimensions. The local web viewer and admin viewer bind only to localhost:

- `http://127.0.0.1:13765/ui`
- `http://127.0.0.1:13765/admin`

For agent installation, use `INSTALL_AGENT_PROMPT.md`.

# Local Memory MCP

Local-only MCP memory server based on Engram.

## What stays

- MCP stdio server for agents.
- Local PostgreSQL storage.
- pgvector semantic search.
- Memory graph, tags, entities, relations, blocks.
- Web UI on `127.0.0.1`.
- Admin UI on `127.0.0.1/admin`.

## What is removed

- Cloud sync.
- Remote MCP HTTP endpoint.
- JWT/cloud auth.
- Qdrant.
- SQLite/PGlite local mode.
- Docker and deployment docs.

## Defaults

| Setting | Value |
|---|---|
| Database | `postgres://local_memory:local_memory@127.0.0.1:55432/local_memory` |
| Embedding model | `openai/text-embedding-3-small` |
| Embedding dimensions | `256` |
| Web host | `127.0.0.1` |
| Web port | `3765` |
| Admin login | `admin / admin` |

## Commands

```bash
pnpm install
pnpm run build
./scripts/local-postgres.sh start
node dist/index.js --stdio
node dist/index.js --web
```

Open:

- Web UI: `http://127.0.0.1:3765/ui`
- Admin UI: `http://127.0.0.1:3765/admin`

BEGIN;

CREATE TABLE IF NOT EXISTS memory_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL,
  team_id TEXT,
  user_id TEXT,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  max_tokens INT NOT NULL DEFAULT 500,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique index on (org_id, team_id, user_id, name) with COALESCE for NULLs.
-- Using a unique index instead of a UNIQUE constraint because PGlite
-- doesn't support functional expressions inside UNIQUE(...) clauses.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_blocks_unique_name
ON memory_blocks (org_id, COALESCE(team_id, ''), COALESCE(user_id, ''), name);


CREATE INDEX IF NOT EXISTS idx_memory_blocks_org_lookup
ON memory_blocks (org_id, name);

COMMIT;

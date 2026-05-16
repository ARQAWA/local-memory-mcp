-- Migration: Transform knowledge_entries into memories
-- Adds memory-specific columns, new indexes, and migrates existing data

BEGIN;

-- Add new columns to knowledge_entries (we'll rename after data migration)
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS memory_type TEXT;
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS scope TEXT DEFAULT 'team';
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS org_id TEXT DEFAULT 'default';
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS user_id TEXT;
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS valid_from TIMESTAMPTZ;
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS valid_until TIMESTAMPTZ;
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS importance FLOAT DEFAULT 0.5;
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS access_count INTEGER DEFAULT 0;
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS last_accessed_at TIMESTAMPTZ;
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS supersedes UUID REFERENCES knowledge_entries(id);
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS created_by TEXT;

-- Migrate existing entry types to memory types
UPDATE knowledge_entries SET memory_type = CASE
  WHEN type IN ('runbook', 'process', 'convention') THEN 'procedure'
  WHEN type = 'decision' THEN 'decision'
  WHEN type = 'pattern' THEN 'reference'
  WHEN type IN ('glossary', 'contact', 'faq') THEN 'fact'
  ELSE 'reference'
END
WHERE memory_type IS NULL;

-- Set scope from visibility
UPDATE knowledge_entries SET scope = CASE
  WHEN visibility = 'team' THEN 'team'
  WHEN visibility = 'org' THEN 'org'
  WHEN visibility = 'public' THEN 'public'
  ELSE 'team'
END;

-- Set created_by from author
UPDATE knowledge_entries SET created_by = author WHERE created_by IS NULL;

-- Set valid_from from created_at
UPDATE knowledge_entries SET valid_from = created_at WHERE valid_from IS NULL;

-- Set last_accessed_at from updated_at
UPDATE knowledge_entries SET last_accessed_at = updated_at WHERE last_accessed_at IS NULL;

-- Now set defaults and NOT NULL after migration (so existing rows are populated)
ALTER TABLE knowledge_entries ALTER COLUMN valid_from SET DEFAULT now();
ALTER TABLE knowledge_entries ALTER COLUMN valid_from SET NOT NULL;
ALTER TABLE knowledge_entries ALTER COLUMN last_accessed_at SET DEFAULT now();
ALTER TABLE knowledge_entries ALTER COLUMN last_accessed_at SET NOT NULL;
ALTER TABLE knowledge_entries ALTER COLUMN memory_type SET NOT NULL;

-- Ensure summary is not null (generate from content if missing)
UPDATE knowledge_entries SET summary = LEFT(content, 200)
WHERE summary IS NULL OR summary = '';

-- Now rename table
ALTER TABLE knowledge_entries RENAME TO memories;

-- Rename tag table references
ALTER TABLE entry_tags RENAME TO memory_tags;
ALTER TABLE memory_tags RENAME COLUMN entry_id TO memory_id;

-- Rename relation table references
ALTER TABLE entry_relations RENAME TO memory_relations;
ALTER TABLE memory_relations RENAME COLUMN source_id TO source_memory_id;
ALTER TABLE memory_relations RENAME COLUMN target_id TO target_memory_id;

-- Update audit log reference
ALTER TABLE audit_log RENAME COLUMN entry_id TO memory_id;

-- Add new indexes for memory queries
CREATE INDEX IF NOT EXISTS idx_memories_scope_team_type
  ON memories(scope, team_id, memory_type)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_org
  ON memories(org_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_user
  ON memories(user_id)
  WHERE deleted_at IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_importance
  ON memories(importance DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_last_accessed
  ON memories(last_accessed_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_valid_until
  ON memories(valid_until)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_supersedes
  ON memories(supersedes)
  WHERE supersedes IS NOT NULL;

-- Recreate HNSW index for better performance (replaces IVFFlat)
DROP INDEX IF EXISTS idx_entries_embedding;
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops);

-- Recreate FTS index on renamed table
DROP INDEX IF EXISTS idx_entries_fts;
CREATE INDEX IF NOT EXISTS idx_memories_fts ON memories
  USING GIN (to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || content));

-- Update existing indexes for renamed table (use new column names)
DROP INDEX IF EXISTS idx_entries_team_type;
CREATE INDEX IF NOT EXISTS idx_memories_team_type ON memories(team_id, memory_type)
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS idx_entries_status;
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)
  WHERE deleted_at IS NULL;

DROP INDEX IF EXISTS idx_entries_visibility;
CREATE INDEX IF NOT EXISTS idx_memories_visibility ON memories(scope)
  WHERE deleted_at IS NULL;

-- CHECK constraints for enum-like columns
ALTER TABLE memories ADD CONSTRAINT chk_memory_type
  CHECK (memory_type IN ('fact', 'decision', 'procedure', 'episode', 'reference'));

ALTER TABLE memories ADD CONSTRAINT chk_scope
  CHECK (scope IN ('personal', 'team', 'org', 'public'));

COMMIT;

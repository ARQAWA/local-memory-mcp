ALTER TABLE memories
  ADD COLUMN card_type TEXT NOT NULL DEFAULT 'fact' CHECK (
    card_type IN (
      'decision', 'process', 'constraint', 'architecture', 'legacy',
      'gotcha', 'roadmap', 'preference', 'task_state', 'reference', 'fact'
    )
  );

ALTER TABLE memories
  ADD COLUMN status TEXT NOT NULL DEFAULT 'current' CHECK (
    status IN (
      'current', 'candidate', 'temporary', 'deprecated', 'superseded',
      'historical', 'wrong', 'needs_review'
    )
  );

ALTER TABLE memories
  ADD COLUMN source_type TEXT NOT NULL DEFAULT 'legacy_import' CHECK (
    source_type IN ('agent', 'user', 'legacy_import', 'import', 'migration', 'tool', 'system')
  );

ALTER TABLE memories
  ADD COLUMN confidence REAL NOT NULL DEFAULT 0.75 CHECK (confidence >= 0 AND confidence <= 1);

ALTER TABLE memories
  ADD COLUMN anchors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(anchors_json));

ALTER TABLE memories
  ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json));

ALTER TABLE memories
  ADD COLUMN supersedes_id TEXT;

UPDATE memories
SET card_type = CASE memory_type
  WHEN 'decision' THEN 'decision'
  WHEN 'procedure' THEN 'process'
  WHEN 'convention' THEN 'constraint'
  WHEN 'episode' THEN 'gotcha'
  WHEN 'reference' THEN 'reference'
  ELSE 'fact'
END,
status = 'current',
source_type = 'legacy_import',
confidence = 0.75,
supersedes_id = COALESCE(supersedes_id, supersedes);

CREATE INDEX IF NOT EXISTS idx_memories_repository_status
  ON memories (repository_id, status, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_card_type
  ON memories (repository_id, card_type, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_updated
  ON memories (repository_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_importance
  ON memories (repository_id, importance DESC, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

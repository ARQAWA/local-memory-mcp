CREATE INDEX IF NOT EXISTS idx_memories_access_count_active
  ON memories (access_count DESC, last_accessed_at DESC, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_access_count_active
  ON memories (repository_id, access_count DESC, last_accessed_at DESC, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

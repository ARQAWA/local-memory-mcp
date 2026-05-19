CREATE EXTENSION IF NOT EXISTS btree_gin;

CREATE INDEX IF NOT EXISTS idx_memories_repository_active_updated
  ON memories (repository_id, updated_at DESC, id)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_type_active
  ON memories (repository_id, memory_type, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_importance_active
  ON memories (repository_id, importance DESC, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_last_accessed
  ON memories (repository_id, last_accessed_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_user_active
  ON memories (repository_id, user_id)
  WHERE deleted_at IS NULL AND valid_until IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_expires_repository
  ON memories (repository_id, expires_at ASC)
  WHERE deleted_at IS NULL AND valid_until IS NULL AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_fts
  ON memories USING GIN (repository_id, fts_vector)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_tags_repository_tag_memory
  ON memory_tags (repository_id, tag, memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_tags_repository_tag_prefix
  ON memory_tags (repository_id, tag text_pattern_ops, memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_source_repository
  ON memory_relations (repository_id, source_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_target_repository
  ON memory_relations (repository_id, target_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_entities_repository_entity
  ON memory_entities (repository_id, entity_id);

CREATE INDEX IF NOT EXISTS idx_memory_entities_repository_memory
  ON memory_entities (repository_id, memory_id);

CREATE INDEX IF NOT EXISTS idx_entities_repository_name
  ON entities (repository_id, name);

CREATE INDEX IF NOT EXISTS idx_entity_relations_source_repository
  ON entity_relations (repository_id, source_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_relations_target_repository
  ON entity_relations (repository_id, target_entity_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_repository_created
  ON audit_log (repository_id, created_at DESC);

DELETE FROM _migrations
WHERE name NOT IN (
  '001_repository_schema.sql',
  '002_repository_cleanup.sql',
  '004_migration_history_cleanup.sql',
  '005_repository_graph_hardening.sql',
  '006_repository_identity_hardening.sql',
  '007_repository_metadata_object_hardening.sql',
  '009_drop_redundant_repository_constraints.sql',
  '010_current_migration_history.sql'
);

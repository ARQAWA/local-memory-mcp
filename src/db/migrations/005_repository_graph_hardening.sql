CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE memory_relations
  ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

UPDATE memory_relations
SET origin = COALESCE(NULLIF(origin, ''), 'manual'),
    confidence = COALESCE(confidence, 1.0),
    metadata = COALESCE(metadata, '{}'::jsonb);

DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM memories WHERE repository_id IS NULL;
  IF bad_count > 0 THEN RAISE EXCEPTION 'memories.repository_id has % NULL rows', bad_count; END IF;

  SELECT COUNT(*) INTO bad_count FROM memories WHERE content IS NULL OR summary IS NULL;
  IF bad_count > 0 THEN RAISE EXCEPTION 'memories content/summary has % NULL rows', bad_count; END IF;

  SELECT COUNT(*) INTO bad_count FROM memories WHERE access_count IS NULL OR last_accessed_at IS NULL;
  IF bad_count > 0 THEN RAISE EXCEPTION 'memory access telemetry has % NULL rows', bad_count; END IF;

  SELECT COUNT(*) INTO bad_count
  FROM memory_tags mt
  LEFT JOIN memories m ON m.id = mt.memory_id
  WHERE m.id IS NULL OR m.repository_id <> mt.repository_id;
  IF bad_count > 0 THEN RAISE EXCEPTION 'memory_tags has % repository mismatch rows', bad_count; END IF;

  SELECT COUNT(*) INTO bad_count
  FROM memory_relations mr
  LEFT JOIN memories src ON src.id = mr.source_memory_id
  LEFT JOIN memories tgt ON tgt.id = mr.target_memory_id
  WHERE src.id IS NULL OR tgt.id IS NULL
    OR src.repository_id <> mr.repository_id
    OR tgt.repository_id <> mr.repository_id;
  IF bad_count > 0 THEN RAISE EXCEPTION 'memory_relations has % repository mismatch rows', bad_count; END IF;

  SELECT COUNT(*) INTO bad_count
  FROM memory_entities me
  LEFT JOIN memories m ON m.id = me.memory_id
  LEFT JOIN entities e ON e.id = me.entity_id
  WHERE m.id IS NULL OR e.id IS NULL
    OR m.repository_id <> me.repository_id
    OR e.repository_id <> me.repository_id;
  IF bad_count > 0 THEN RAISE EXCEPTION 'memory_entities has % repository mismatch rows', bad_count; END IF;

  SELECT COUNT(*) INTO bad_count
  FROM entity_relations er
  LEFT JOIN entities src ON src.id = er.source_entity_id
  LEFT JOIN entities tgt ON tgt.id = er.target_entity_id
  LEFT JOIN memories m ON m.id = er.memory_id
  WHERE src.id IS NULL OR tgt.id IS NULL
    OR src.repository_id <> er.repository_id
    OR tgt.repository_id <> er.repository_id
    OR (er.memory_id IS NOT NULL AND (m.id IS NULL OR m.repository_id <> er.repository_id));
  IF bad_count > 0 THEN RAISE EXCEPTION 'entity_relations has % repository mismatch rows', bad_count; END IF;

  SELECT COUNT(*) INTO bad_count
  FROM audit_log a
  LEFT JOIN memories m ON m.id = a.memory_id
  WHERE a.memory_id IS NOT NULL
    AND (m.id IS NULL OR m.repository_id <> a.repository_id);
  IF bad_count > 0 THEN RAISE EXCEPTION 'audit_log has % repository mismatch rows', bad_count; END IF;
END $$;

ALTER TABLE memories
  ALTER COLUMN repository_id SET NOT NULL,
  ALTER COLUMN memory_type SET NOT NULL,
  ALTER COLUMN content SET NOT NULL,
  ALTER COLUMN summary SET NOT NULL,
  ALTER COLUMN valid_from SET NOT NULL,
  ALTER COLUMN created_at SET NOT NULL,
  ALTER COLUMN updated_at SET NOT NULL,
  ALTER COLUMN importance SET NOT NULL,
  ALTER COLUMN access_count SET NOT NULL,
  ALTER COLUMN last_accessed_at SET NOT NULL,
  ALTER COLUMN created_by SET NOT NULL;

ALTER TABLE memory_tags
  ALTER COLUMN repository_id SET NOT NULL,
  ALTER COLUMN memory_id SET NOT NULL,
  ALTER COLUMN tag SET NOT NULL;

ALTER TABLE memory_relations
  ALTER COLUMN repository_id SET NOT NULL,
  ALTER COLUMN source_memory_id SET NOT NULL,
  ALTER COLUMN target_memory_id SET NOT NULL,
  ALTER COLUMN relation_type SET NOT NULL,
  ALTER COLUMN origin SET NOT NULL,
  ALTER COLUMN confidence SET NOT NULL,
  ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE entities
  ALTER COLUMN repository_id SET NOT NULL,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN entity_type SET NOT NULL,
  ALTER COLUMN metadata SET NOT NULL;

ALTER TABLE memory_entities
  ALTER COLUMN repository_id SET NOT NULL,
  ALTER COLUMN memory_id SET NOT NULL,
  ALTER COLUMN entity_id SET NOT NULL,
  ALTER COLUMN relevance SET NOT NULL;

ALTER TABLE entity_relations
  ALTER COLUMN repository_id SET NOT NULL,
  ALTER COLUMN source_entity_id SET NOT NULL,
  ALTER COLUMN target_entity_id SET NOT NULL,
  ALTER COLUMN relation_type SET NOT NULL;

ALTER TABLE memory_blocks
  ALTER COLUMN repository_id SET NOT NULL,
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN content SET NOT NULL,
  ALTER COLUMN max_tokens SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_id_repository_id_key') THEN
    ALTER TABLE memories ADD CONSTRAINT memories_id_repository_id_key UNIQUE (id, repository_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entities_id_repository_id_key') THEN
    ALTER TABLE entities ADD CONSTRAINT entities_id_repository_id_key UNIQUE (id, repository_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_relations_relation_type_check') THEN
    ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_relation_type_check
      CHECK (relation_type IN ('supersedes', 'depends_on', 'related_to', 'implements', 'alternative_to', 'contradicts'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_relations_origin_check') THEN
    ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_origin_check
      CHECK (origin IN ('manual', 'lineage', 'derived'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_relations_confidence_check') THEN
    ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_confidence_check
      CHECK (confidence >= 0 AND confidence <= 1);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_supersedes_repository_fkey') THEN
    ALTER TABLE memories ADD CONSTRAINT memories_supersedes_repository_fkey
      FOREIGN KEY (supersedes, repository_id) REFERENCES memories(id, repository_id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_tags_memory_repository_fkey') THEN
    ALTER TABLE memory_tags ADD CONSTRAINT memory_tags_memory_repository_fkey
      FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_relations_source_repository_fkey') THEN
    ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_source_repository_fkey
      FOREIGN KEY (source_memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_relations_target_repository_fkey') THEN
    ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_target_repository_fkey
      FOREIGN KEY (target_memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_entities_memory_repository_fkey') THEN
    ALTER TABLE memory_entities ADD CONSTRAINT memory_entities_memory_repository_fkey
      FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_entities_entity_repository_fkey') THEN
    ALTER TABLE memory_entities ADD CONSTRAINT memory_entities_entity_repository_fkey
      FOREIGN KEY (entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_relations_source_repository_fkey') THEN
    ALTER TABLE entity_relations ADD CONSTRAINT entity_relations_source_repository_fkey
      FOREIGN KEY (source_entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_relations_target_repository_fkey') THEN
    ALTER TABLE entity_relations ADD CONSTRAINT entity_relations_target_repository_fkey
      FOREIGN KEY (target_entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_relations_memory_repository_fkey') THEN
    ALTER TABLE entity_relations ADD CONSTRAINT entity_relations_memory_repository_fkey
      FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_log_memory_repository_fkey') THEN
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_memory_repository_fkey
      FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE NOT VALID;
  END IF;
END $$;

ALTER TABLE memories VALIDATE CONSTRAINT memories_supersedes_repository_fkey;
ALTER TABLE memory_tags VALIDATE CONSTRAINT memory_tags_memory_repository_fkey;
ALTER TABLE memory_relations VALIDATE CONSTRAINT memory_relations_source_repository_fkey;
ALTER TABLE memory_relations VALIDATE CONSTRAINT memory_relations_target_repository_fkey;
ALTER TABLE memory_entities VALIDATE CONSTRAINT memory_entities_memory_repository_fkey;
ALTER TABLE memory_entities VALIDATE CONSTRAINT memory_entities_entity_repository_fkey;
ALTER TABLE entity_relations VALIDATE CONSTRAINT entity_relations_source_repository_fkey;
ALTER TABLE entity_relations VALIDATE CONSTRAINT entity_relations_target_repository_fkey;
ALTER TABLE entity_relations VALIDATE CONSTRAINT entity_relations_memory_repository_fkey;
ALTER TABLE audit_log VALIDATE CONSTRAINT audit_log_memory_repository_fkey;

DELETE FROM memory_relations mr
USING memories src, memories tgt
WHERE mr.relation_type <> 'supersedes'
  AND src.id = mr.source_memory_id
  AND tgt.id = mr.target_memory_id
  AND (
    src.deleted_at IS NOT NULL OR src.valid_until IS NOT NULL OR (src.expires_at IS NOT NULL AND src.expires_at <= now())
    OR tgt.deleted_at IS NOT NULL OR tgt.valid_until IS NOT NULL OR (tgt.expires_at IS NOT NULL AND tgt.expires_at <= now())
  );

INSERT INTO memory_relations (
  id, repository_id, source_memory_id, target_memory_id, relation_type,
  description, origin, confidence, metadata
)
SELECT gen_random_uuid(), m.repository_id, m.id, m.supersedes, 'supersedes',
  'Memory supersedes a previous version.', 'lineage', 1.0, '{"source":"backfill"}'::jsonb
FROM memories m
WHERE m.supersedes IS NOT NULL
ON CONFLICT (repository_id, source_memory_id, target_memory_id, relation_type)
DO UPDATE SET origin = 'lineage', confidence = 1.0,
  metadata = memory_relations.metadata || '{"source":"backfill"}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_repositories_last_seen
  ON repositories (last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_repository_memory_created
  ON audit_log (repository_id, memory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entities_repository_name_trgm
  ON entities USING GIN (repository_id uuid_ops, name gin_trgm_ops);

DROP INDEX IF EXISTS idx_memories_embedding;
CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 24, ef_construction = 128)
  WHERE embedding IS NOT NULL AND deleted_at IS NULL AND valid_until IS NULL;

DROP INDEX IF EXISTS idx_audit_created;
DROP INDEX IF EXISTS idx_audit_entry;
DROP INDEX IF EXISTS idx_memories_supersedes;

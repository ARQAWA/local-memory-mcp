CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  root_hash TEXT NOT NULL UNIQUE,
  remote_url_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT repositories_root_hash_sha256 CHECK (root_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT repositories_metadata_is_object CHECK (jsonb_typeof(metadata) = 'object'),
  CONSTRAINT repositories_metadata_identity_kind CHECK (
    metadata ? 'identity_kind'
    AND metadata->>'identity_kind' IN ('git', 'folder')
  )
);

CREATE TABLE IF NOT EXISTS memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  user_id TEXT,
  memory_type TEXT NOT NULL CHECK (
    memory_type IN ('fact', 'decision', 'procedure', 'episode', 'reference', 'convention')
  ),
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  embedding vector(256),
  fts_vector tsvector GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(summary, '') || ' ' || content)
  ) STORED,
  valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  importance DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL DEFAULT 'agent',
  source TEXT,
  external_id TEXT,
  supersedes UUID,
  group_id UUID,
  sequence INTEGER,
  group_type VARCHAR(50),
  deleted_at TIMESTAMPTZ,
  CONSTRAINT memories_id_repository_id_key UNIQUE (id, repository_id),
  CONSTRAINT memories_supersedes_repository_fkey
    FOREIGN KEY (supersedes, repository_id) REFERENCES memories(id, repository_id)
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  CONSTRAINT memory_tags_memory_repository_fkey
    FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL,
  source_memory_id UUID NOT NULL,
  target_memory_id UUID NOT NULL,
  relation_type TEXT NOT NULL,
  description TEXT,
  origin TEXT NOT NULL DEFAULT 'manual',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, source_memory_id, target_memory_id, relation_type),
  CHECK (source_memory_id <> target_memory_id),
  CONSTRAINT memory_relations_relation_type_check
    CHECK (relation_type IN ('supersedes', 'depends_on', 'related_to', 'implements', 'alternative_to', 'contradicts')),
  CONSTRAINT memory_relations_origin_check CHECK (origin IN ('manual', 'lineage', 'derived')),
  CONSTRAINT memory_relations_confidence_check CHECK (confidence >= 0 AND confidence <= 1),
  CONSTRAINT memory_relations_source_repository_fkey
    FOREIGN KEY (source_memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE,
  CONSTRAINT memory_relations_target_repository_fkey
    FOREIGN KEY (target_memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  memory_id UUID,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT audit_log_memory_repository_fkey
    FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('service', 'file', 'package', 'person', 'concept', 'api', 'error', 'env_var')
  ),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT entities_id_repository_id_key UNIQUE (id, repository_id),
  UNIQUE (repository_id, entity_type, name)
);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id UUID NOT NULL,
  repository_id UUID NOT NULL,
  entity_id UUID NOT NULL,
  relevance DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, entity_id),
  CONSTRAINT memory_entities_memory_repository_fkey
    FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE,
  CONSTRAINT memory_entities_entity_repository_fkey
    FOREIGN KEY (entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL,
  source_entity_id UUID NOT NULL,
  target_entity_id UUID NOT NULL,
  relation_type TEXT NOT NULL,
  description TEXT,
  memory_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, source_entity_id, target_entity_id, relation_type),
  CONSTRAINT entity_relations_source_repository_fkey
    FOREIGN KEY (source_entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE,
  CONSTRAINT entity_relations_target_repository_fkey
    FOREIGN KEY (target_entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE,
  CONSTRAINT entity_relations_memory_repository_fkey
    FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_blocks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  max_tokens INTEGER NOT NULL DEFAULT 500,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, name)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_external_id_repository
  ON memories (repository_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_group_seq_repository
  ON memories (repository_id, group_id, sequence)
  WHERE group_id IS NOT NULL AND sequence IS NOT NULL AND deleted_at IS NULL;

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

CREATE INDEX IF NOT EXISTS idx_memories_expires_repository
  ON memories (repository_id, expires_at ASC)
  WHERE deleted_at IS NULL AND valid_until IS NULL AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_fts
  ON memories USING GIN (fts_vector)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_fts
  ON memories USING GIN (repository_id, fts_vector)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 24, ef_construction = 128)
  WHERE embedding IS NOT NULL AND deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memory_tags_repository_tag_memory
  ON memory_tags (repository_id, tag, memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_tags_repository_tag_prefix
  ON memory_tags (repository_id, tag text_pattern_ops, memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_source_repository
  ON memory_relations (repository_id, source_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_target_repository
  ON memory_relations (repository_id, target_memory_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_repository_created
  ON audit_log (repository_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_memory_entities_repository_entity
  ON memory_entities (repository_id, entity_id);

CREATE INDEX IF NOT EXISTS idx_memory_entities_repository_memory
  ON memory_entities (repository_id, memory_id);

CREATE INDEX IF NOT EXISTS idx_entities_repository_name
  ON entities (repository_id, name);

CREATE INDEX IF NOT EXISTS idx_entities_repository_name_trgm
  ON entities USING GIN (repository_id uuid_ops, name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_audit_log_repository_memory_created
  ON audit_log (repository_id, memory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_relations_source_repository
  ON entity_relations (repository_id, source_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_relations_target_repository
  ON entity_relations (repository_id, target_entity_id);

CREATE INDEX IF NOT EXISTS idx_repositories_last_seen
  ON repositories (last_seen_at DESC);

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS btree_gin;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  root_path TEXT,
  root_hash TEXT NOT NULL UNIQUE,
  remote_url_hash TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  supersedes UUID REFERENCES memories(id) ON DELETE SET NULL,
  group_id UUID,
  sequence INTEGER,
  group_type VARCHAR(50),
  deleted_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  description TEXT,
  origin TEXT NOT NULL DEFAULT 'manual',
  confidence DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, source_memory_id, target_memory_id, relation_type),
  CHECK (source_memory_id <> target_memory_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  memory_id UUID REFERENCES memories(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
  UNIQUE (repository_id, entity_type, name)
);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relevance DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, entity_id)
);

CREATE TABLE IF NOT EXISTS entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repository_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  description TEXT,
  memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repository_id, source_entity_id, target_entity_id, relation_type)
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

CREATE INDEX IF NOT EXISTS idx_entities_name_trgm
  ON entities USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_audit_log_repository_memory_created
  ON audit_log (repository_id, memory_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_entity_relations_source_repository
  ON entity_relations (repository_id, source_entity_id);

CREATE INDEX IF NOT EXISTS idx_entity_relations_target_repository
  ON entity_relations (repository_id, target_entity_id);

CREATE INDEX IF NOT EXISTS idx_repositories_last_seen
  ON repositories (last_seen_at DESC);

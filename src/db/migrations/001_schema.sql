CREATE TABLE IF NOT EXISTS repositories (
  pk INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,
  root_hash TEXT NOT NULL UNIQUE,
  remote_url_hash TEXT,
  metadata TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata))
    CHECK (json_extract(metadata, '$.identity_kind') IN ('git', 'folder')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (root_hash GLOB '[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]')
);

CREATE TABLE IF NOT EXISTS memories (
  pk INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL,
  user_id TEXT,
  memory_type TEXT NOT NULL CHECK (
    memory_type IN ('fact', 'decision', 'procedure', 'episode', 'reference', 'convention')
  ),
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  valid_from TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  valid_until TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT,
  importance REAL NOT NULL DEFAULT 0.5,
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by TEXT NOT NULL DEFAULT 'agent',
  source TEXT,
  external_id TEXT,
  supersedes TEXT,
  group_id TEXT,
  sequence INTEGER,
  group_type TEXT,
  deleted_at TEXT,
  UNIQUE (id, repository_id),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (supersedes, repository_id) REFERENCES memories(id, repository_id)
);

CREATE TABLE IF NOT EXISTS memory_tags (
  memory_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag),
  FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_relations (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  source_memory_id TEXT NOT NULL,
  target_memory_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (
    relation_type IN ('supersedes', 'depends_on', 'related_to', 'implements', 'alternative_to', 'contradicts')
  ),
  description TEXT,
  origin TEXT NOT NULL DEFAULT 'manual' CHECK (origin IN ('manual', 'lineage', 'derived')),
  confidence REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (repository_id, source_memory_id, target_memory_id, relation_type),
  CHECK (source_memory_id <> target_memory_id),
  FOREIGN KEY (source_memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE,
  FOREIGN KEY (target_memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  memory_id TEXT,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  changes TEXT CHECK (changes IS NULL OR json_valid(changes)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entities (
  pk INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (
    entity_type IN ('service', 'file', 'package', 'person', 'concept', 'api', 'error', 'env_var')
  ),
  metadata TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (id, repository_id),
  UNIQUE (repository_id, entity_type, name),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id TEXT NOT NULL,
  repository_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  relevance REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (memory_id, entity_id),
  FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE,
  FOREIGN KEY (entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS entity_relations (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  source_entity_id TEXT NOT NULL,
  target_entity_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  description TEXT,
  memory_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (repository_id, source_entity_id, target_entity_id, relation_type),
  FOREIGN KEY (source_entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE,
  FOREIGN KEY (target_entity_id, repository_id) REFERENCES entities(id, repository_id) ON DELETE CASCADE,
  FOREIGN KEY (memory_id, repository_id) REFERENCES memories(id, repository_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS memory_blocks (
  id TEXT PRIMARY KEY,
  repository_id TEXT NOT NULL,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  max_tokens INTEGER NOT NULL DEFAULT 500,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (repository_id, name),
  FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  summary,
  content,
  content='memories',
  content_rowid='pk',
  tokenize='unicode61'
);

CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  name,
  content='entities',
  content_rowid='pk',
  tokenize='trigram'
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_vectors USING vec0(
  memory_pk INTEGER PRIMARY KEY,
  repository_pk INTEGER PARTITION KEY,
  embedding FLOAT[256] distance_metric=cosine
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, summary, content) VALUES (new.pk, new.summary, new.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, content)
  VALUES('delete', old.pk, old.summary, old.content);
  DELETE FROM memory_vectors WHERE memory_pk = old.pk;
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, summary, content)
  VALUES('delete', old.pk, old.summary, old.content);
  INSERT INTO memories_fts(rowid, summary, content) VALUES (new.pk, new.summary, new.content);
END;

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(rowid, name) VALUES (new.pk, new.name);
END;

CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name) VALUES('delete', old.pk, old.name);
END;

CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  INSERT INTO entities_fts(entities_fts, rowid, name) VALUES('delete', old.pk, old.name);
  INSERT INTO entities_fts(rowid, name) VALUES (new.pk, new.name);
END;

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

CREATE INDEX IF NOT EXISTS idx_memories_repository_last_accessed
  ON memories (repository_id, last_accessed_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_access_count_active
  ON memories (access_count DESC, last_accessed_at DESC, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_access_count_active
  ON memories (repository_id, access_count DESC, last_accessed_at DESC, updated_at DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_repository_user_active
  ON memories (repository_id, user_id)
  WHERE deleted_at IS NULL AND valid_until IS NULL AND user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memory_tags_repository_tag_memory
  ON memory_tags (repository_id, tag, memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_source_repository
  ON memory_relations (repository_id, source_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_relations_target_repository
  ON memory_relations (repository_id, target_memory_id);

CREATE INDEX IF NOT EXISTS idx_audit_log_repository_created
  ON audit_log (repository_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_log_repository_memory_created
  ON audit_log (repository_id, memory_id, created_at DESC);

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

CREATE INDEX IF NOT EXISTS idx_repositories_last_seen
  ON repositories (last_seen_at DESC);

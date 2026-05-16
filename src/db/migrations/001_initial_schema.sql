-- Local extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Teams that use this knowledge base
CREATE TABLE IF NOT EXISTS teams (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT UNIQUE NOT NULL,
    name        TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Central knowledge entries
CREATE TABLE IF NOT EXISTS knowledge_entries (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id     UUID NOT NULL REFERENCES teams(id),
    type        TEXT NOT NULL,
    title       TEXT NOT NULL,
    content     TEXT NOT NULL,
    summary     TEXT,
    status      TEXT DEFAULT 'active',
    visibility  TEXT DEFAULT 'team',
    author      TEXT NOT NULL,
    metadata    JSONB DEFAULT '{}',
    created_at  TIMESTAMPTZ DEFAULT now(),
    updated_at  TIMESTAMPTZ DEFAULT now(),
    deleted_at  TIMESTAMPTZ
);

-- Tags for multi-dimensional classification
CREATE TABLE IF NOT EXISTS entry_tags (
    entry_id    UUID REFERENCES knowledge_entries(id) ON DELETE CASCADE,
    tag         TEXT NOT NULL,
    PRIMARY KEY (entry_id, tag)
);

-- Typed relationships between entries
CREATE TABLE IF NOT EXISTS entry_relations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_id       UUID NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
    target_id       UUID NOT NULL REFERENCES knowledge_entries(id) ON DELETE CASCADE,
    relation_type   TEXT NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ DEFAULT now(),
    UNIQUE(source_id, target_id, relation_type)
);

-- Audit trail for all changes
CREATE TABLE IF NOT EXISTS audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entry_id    UUID REFERENCES knowledge_entries(id),
    action      TEXT NOT NULL,
    actor       TEXT NOT NULL,
    changes     JSONB,
    created_at  TIMESTAMPTZ DEFAULT now()
);

-- Common query indexes
CREATE INDEX IF NOT EXISTS idx_entries_team_type ON knowledge_entries(team_id, type) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entries_status ON knowledge_entries(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entries_visibility ON knowledge_entries(visibility) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_tags_tag ON entry_tags(tag);
CREATE INDEX IF NOT EXISTS idx_audit_entry ON audit_log(entry_id);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

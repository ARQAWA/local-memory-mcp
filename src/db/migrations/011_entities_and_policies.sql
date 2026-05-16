-- Migration 011: Entities table for knowledge graph + memory policies for selective memory
-- Supports: auto-entity extraction, knowledge graph queries, selective memory rules

-- Entities table: extracted entities from memory content
CREATE TABLE IF NOT EXISTS entities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('service', 'file', 'package', 'person', 'concept', 'api', 'error', 'env_var')),
  org_id TEXT NOT NULL DEFAULT 'default',
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique constraint: one entity per name+type+org
CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_unique
  ON entities (org_id, entity_type, name);

-- Memory-entity junction: which memories mention which entities
CREATE TABLE IF NOT EXISTS memory_entities (
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relevance FLOAT DEFAULT 1.0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entities_entity
  ON memory_entities (entity_id);

-- Entity relations: relationships between entities (service depends on service, etc.)
CREATE TABLE IF NOT EXISTS entity_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,
  description TEXT,
  memory_id UUID REFERENCES memories(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_entity_id, target_entity_id, relation_type)
);

CREATE INDEX IF NOT EXISTS idx_entity_relations_source
  ON entity_relations (source_entity_id);


CREATE INDEX IF NOT EXISTS idx_entity_relations_target
  ON entity_relations (target_entity_id);

-- Memory policies: selective memory rules per team/org
CREATE TABLE IF NOT EXISTS memory_policies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id TEXT NOT NULL DEFAULT 'default',
  team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
  rules JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Note: uniqueness enforced via partial indexes below (SQL NULL != NULL defeats simple UNIQUE)
  CONSTRAINT memory_policies_check CHECK (true)
);

-- One policy per org+team (when team is specified)
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_policies_org_team
  ON memory_policies (org_id, team_id) WHERE team_id IS NOT NULL;

-- One org-level policy (when no team)
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_policies_org_only
  ON memory_policies (org_id) WHERE team_id IS NULL;


-- Audit log: add 'read' action for compliance (widen CHECK if one exists)
-- Note: we use TEXT type for action, so no CHECK constraint to update

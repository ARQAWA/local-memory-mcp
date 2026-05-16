-- Migration 022: Add external_id column for idempotent memory ingestion.
-- Allows external systems to provide a stable identifier for upsert semantics.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS external_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_external_id_org
  ON memories (org_id, external_id)
  WHERE external_id IS NOT NULL AND deleted_at IS NULL;

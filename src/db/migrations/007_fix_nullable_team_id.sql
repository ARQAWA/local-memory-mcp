-- Migration: Make team_id nullable and fix constraint names after table renames
-- team_id must be nullable because memories can be created without a team_slug

BEGIN;

-- 1. Drop the NOT NULL constraint on team_id
ALTER TABLE memories ALTER COLUMN team_id DROP NOT NULL;

-- 2. Fix stale FK constraint names left over from table/column renames in migration 004
--    These are cosmetic but prevent confusion during debugging.
ALTER TABLE memory_tags DROP CONSTRAINT IF EXISTS entry_tags_entry_id_fkey;
ALTER TABLE memory_tags DROP CONSTRAINT IF EXISTS entry_tags_pkey;
ALTER TABLE memory_tags ADD CONSTRAINT memory_tags_pkey PRIMARY KEY (memory_id, tag);

ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS entry_relations_source_id_fkey;
ALTER TABLE memory_relations DROP CONSTRAINT IF EXISTS entry_relations_target_id_fkey;
ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_source_fkey
  FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE CASCADE;
ALTER TABLE memory_relations ADD CONSTRAINT memory_relations_target_fkey
  FOREIGN KEY (target_memory_id) REFERENCES memories(id) ON DELETE CASCADE;

ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_entry_id_fkey;
ALTER TABLE audit_log ADD CONSTRAINT audit_log_memory_id_fkey
  FOREIGN KEY (memory_id) REFERENCES memories(id);

COMMIT;

BEGIN;

-- Add missing FK constraint on memory_tags.memory_id (dropped in 007 rename, never recreated)
-- Use CASCADE so deleting a memory automatically removes its tags
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'memory_tags_memory_id_fkey'
      AND table_name = 'memory_tags'
  ) THEN
    ALTER TABLE memory_tags
      ADD CONSTRAINT memory_tags_memory_id_fkey
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE;
  END IF;
END $$;

-- Add missing index on memory_relations.target_memory_id for reverse lookups
-- (source_memory_id has an implicit index from the FK, but target does not)
CREATE INDEX IF NOT EXISTS idx_memory_relations_target
  ON memory_relations(target_memory_id);

-- Ensure UNIQUE constraint on (source, target, relation_type) survived the 004 rename
-- PostgreSQL preserves constraints on RENAME, but add explicitly for safety
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'memory_relations'
      AND constraint_type = 'UNIQUE'
  ) THEN
    ALTER TABLE memory_relations
      ADD CONSTRAINT memory_relations_unique
      UNIQUE (source_memory_id, target_memory_id, relation_type);
  END IF;
END $$;

COMMIT;

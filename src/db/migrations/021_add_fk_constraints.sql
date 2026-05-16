-- Migration 021: Add missing foreign key constraints
-- memory_blocks.team_id → teams(id) and sync_queue.memory_id → memories(id)

-- Clean up orphaned rows before adding FK constraints.
-- memory_blocks.team_id may reference teams that no longer exist.
UPDATE memory_blocks SET team_id = NULL
WHERE team_id IS NOT NULL AND team_id NOT IN (SELECT id FROM teams);

-- sync_queue.memory_id may reference memories that were hard-deleted.
DELETE FROM sync_queue
WHERE memory_id NOT IN (SELECT id FROM memories);

-- Add FK on memory_blocks.team_id → teams(id) if not already present.
-- Uses DO block to avoid errors if constraint already exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'memory_blocks'
      AND constraint_name = 'fk_memory_blocks_team_id'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE memory_blocks
      ADD CONSTRAINT fk_memory_blocks_team_id
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- Add FK on sync_queue.memory_id → memories(id) ON DELETE CASCADE if not already present.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_schema = 'public'
      AND table_name = 'sync_queue'
      AND constraint_name = 'fk_sync_queue_memory_id'
      AND constraint_type = 'FOREIGN KEY'
  ) THEN
    ALTER TABLE sync_queue
      ADD CONSTRAINT fk_sync_queue_memory_id
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE;
  END IF;
END
$$;

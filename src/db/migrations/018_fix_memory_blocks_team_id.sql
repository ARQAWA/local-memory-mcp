-- Migration 018: Fix memory_blocks.team_id type
-- Previously stored team slugs (TEXT); now stores team UUIDs to match memories.team_id.
-- Also converts sync_queue.memory_id to UUID type for consistency.
--
-- Safety: the deployed code (blocks.ts) stored team slugs directly as team_id.
-- We must convert all slugs → UUIDs before ALTER COLUMN, and handle orphaned
-- slugs that have no matching teams row (set to NULL rather than lose the block).

BEGIN;

-- Step 1: Convert known slug values to UUIDs by joining with teams table
UPDATE memory_blocks
SET team_id = t.id::text
FROM teams t
WHERE memory_blocks.team_id = t.slug
  AND memory_blocks.team_id IS NOT NULL;

-- Step 2: Nullify any remaining team_id values that are not valid UUIDs.
-- These are orphaned slugs where the team no longer exists. Setting to NULL
-- preserves the memory_block data (no data loss) — it just loses team scoping.
UPDATE memory_blocks
SET team_id = NULL
WHERE team_id IS NOT NULL
  AND team_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Step 3: Drop the old unique index that uses COALESCE(team_id, '') with TEXT.
-- After ALTER COLUMN to UUID, COALESCE(uuid, '') would fail (type mismatch).
DROP INDEX IF EXISTS idx_memory_blocks_unique_name;

-- Step 4: Now safe to change column type — all values are NULL or valid UUIDs
ALTER TABLE memory_blocks ALTER COLUMN team_id TYPE UUID USING team_id::uuid;

-- Step 5: Recreate the unique index using a nil UUID sentinel instead of empty string.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_blocks_unique_name
ON memory_blocks (org_id, COALESCE(team_id, '00000000-0000-0000-0000-000000000000'::uuid), COALESCE(user_id, ''), name);

-- Step 6: Clean up sync_queue rows with non-UUID memory_id (should not exist in
-- cloud mode, but guard against residual data from hybrid clients or tests).
DELETE FROM sync_queue
WHERE memory_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';

-- Step 7: Change sync_queue.memory_id from TEXT to UUID
ALTER TABLE sync_queue ALTER COLUMN memory_id TYPE UUID USING memory_id::uuid;

COMMIT;

-- Migration: Add 'convention' to memory_type CHECK constraint

BEGIN;

-- Drop and recreate the CHECK constraint to include 'convention'
ALTER TABLE memories DROP CONSTRAINT IF EXISTS chk_memory_type;
ALTER TABLE memories ADD CONSTRAINT chk_memory_type
  CHECK (memory_type IN ('fact', 'decision', 'procedure', 'episode', 'reference', 'convention'));

COMMIT;

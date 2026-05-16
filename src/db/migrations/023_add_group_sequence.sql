-- Migration 023: Add group_id + sequence fields for related memory sequences.
-- Allows memories to be organized into ordered groups (e.g., document chunks,
-- conversation threads, multi-step procedures).

ALTER TABLE memories ADD COLUMN IF NOT EXISTS group_id UUID;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS sequence INTEGER;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS group_type VARCHAR(50);

-- Enforce unique sequence within a group (only for active memories).
-- Superseded memories (valid_until IS NOT NULL) are excluded so corrections
-- can reuse the same (group_id, sequence) slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_group_seq_unique
  ON memories(group_id, sequence)
  WHERE group_id IS NOT NULL AND valid_until IS NULL AND deleted_at IS NULL;

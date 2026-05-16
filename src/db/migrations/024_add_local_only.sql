-- Migration 024: Add local_only column to memories
-- Allows memories to be excluded from cloud sync in hybrid mode.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS local_only BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_memories_local_only ON memories(local_only) WHERE local_only = true;

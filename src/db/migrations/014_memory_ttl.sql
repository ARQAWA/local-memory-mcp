-- Migration 014: TTL (time-to-live) support for auto-expiring memories
-- Adds expires_at column for automatic memory expiration.
-- Expired memories are soft-deleted by a background cleanup job.

ALTER TABLE memories ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Index for efficient expiration sweep (only non-deleted memories with TTL set)
CREATE INDEX IF NOT EXISTS idx_memories_expires_at
  ON memories (expires_at ASC)
  WHERE deleted_at IS NULL AND expires_at IS NOT NULL;

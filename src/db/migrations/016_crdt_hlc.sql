-- Add HLC (Hybrid Logical Clock) columns for CRDT-based sync.
-- Enables per-field Last-Writer-Wins conflict resolution across distributed agents.

BEGIN;

-- HLC timestamp (serialized): "{wallTime}-{counterHex}-{nodeId}"
ALTER TABLE memories ADD COLUMN IF NOT EXISTS hlc TEXT;

-- Wall time extracted for efficient range queries and sync cursors
ALTER TABLE memories ADD COLUMN IF NOT EXISTS hlc_wall BIGINT;

-- Per-field HLC map (JSON): {"content": "1710000000000-002a-node1", "summary": "..."}
ALTER TABLE memories ADD COLUMN IF NOT EXISTS field_hlcs TEXT DEFAULT '{}';

-- Indexes for HLC-based sync
CREATE INDEX IF NOT EXISTS idx_memories_hlc_wall ON memories(hlc_wall);
CREATE INDEX IF NOT EXISTS idx_memories_hlc_sync ON memories(hlc_wall) WHERE deleted_at IS NULL;

COMMIT;

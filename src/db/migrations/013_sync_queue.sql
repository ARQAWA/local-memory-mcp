-- Migration 013: Persistent sync queue for hybrid mode
-- Replaces in-memory pendingPush Set to prevent data loss on crash.

CREATE TABLE IF NOT EXISTS sync_queue (
  memory_id TEXT PRIMARY KEY,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_queued
  ON sync_queue (queued_at ASC);

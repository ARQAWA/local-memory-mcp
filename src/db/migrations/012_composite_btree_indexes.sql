-- Migration 012: Composite B-tree indexes for common query patterns
-- These partial indexes cover the most frequent filter combinations used by
-- repository queries (list, search, sync, user-scoped).
-- @no-transaction (CONCURRENTLY cannot run inside a transaction)

-- Primary filter pattern: org + team scoped active memories
-- Used by: list(), searchFts(), searchSemantic(), findSimilar()
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_org_team_active
  ON memories (org_id, team_id)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

-- Sync query pattern: ordered by updated_at for delta sync
-- Used by: listForSync()
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_sync
  ON memories (org_id, updated_at, id)
  WHERE deleted_at IS NULL;

-- User-scoped queries (personal memories)
-- Used by: list() with user_id filter
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_user_active
  ON memories (org_id, user_id)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

-- Memory type filter (common in list/search)
-- Used by: list() with memory_type filter, export_conventions
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_type_active
  ON memories (org_id, memory_type)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

-- Importance ordering for active memories (used by searchByTagPrefix, getActiveContext)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_importance_active
  ON memories (org_id, importance DESC)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

-- Tune autovacuum for heavy-update table
ALTER TABLE memories SET (
  autovacuum_vacuum_scale_factor = 0.05,
  autovacuum_analyze_scale_factor = 0.02
);

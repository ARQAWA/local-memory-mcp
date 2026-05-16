-- Fix HNSW index parameters: migration 010 downgraded from m=24,ef_construction=128
-- (set in 006) to m=16,ef_construction=64. Restore the intended quality parameters.
-- Also restores the partial index WHERE clause from 006/010 (only index active memories).
-- @no-transaction
DROP INDEX IF EXISTS idx_memories_embedding;
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 24, ef_construction = 128)
  WHERE deleted_at IS NULL AND valid_until IS NULL AND embedding IS NOT NULL;

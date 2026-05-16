-- Migration: Performance indexes — tuned HNSW, partial vector index, stored tsvector
-- Optimizations for 1000-engineer scale

BEGIN;

-- 1. Add stored tsvector column for faster FTS ranking
--    Avoids recomputing tsvector per row on every search
ALTER TABLE memories ADD COLUMN IF NOT EXISTS fts_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', COALESCE(title, '') || ' ' || COALESCE(summary, '') || ' ' || content)
  ) STORED;

-- 2. Replace expression-based GIN index with stored column index
DROP INDEX IF EXISTS idx_memories_fts;
CREATE INDEX idx_memories_fts ON memories USING GIN (fts_vector)
  WHERE deleted_at IS NULL AND valid_until IS NULL;

-- 3. Replace default HNSW index with tuned partial index
--    m=24 (more connections per node = better recall)
--    ef_construction=128 (better graph quality during build)
--    Partial: only indexes active memories with embeddings
DROP INDEX IF EXISTS idx_memories_embedding;
CREATE INDEX idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 24, ef_construction = 128)
  WHERE deleted_at IS NULL AND valid_until IS NULL AND embedding IS NOT NULL;

COMMIT;

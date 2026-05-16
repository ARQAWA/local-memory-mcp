-- Migration: Fix embedding vector dimension to match local OpenRouter default (256)
-- The default EMBEDDING_DIMENSION config is 256 for OpenAI text-embedding-3-small
-- via OpenRouter. This clears existing
-- embeddings (they'll be regenerated on next remember), alters the column,
-- and recreates the HNSW index for the new dimension.

-- Drop existing indexes that reference the embedding column
DROP INDEX IF EXISTS idx_memories_embedding;
DROP INDEX IF EXISTS idx_memories_embedding_active;

-- Clear existing embeddings so ALTER TYPE can change dimensions safely
-- (cannot alter vector dimension on a column containing data of a different size)
UPDATE memories SET embedding = NULL WHERE embedding IS NOT NULL;

-- Alter column to 256 dimensions
ALTER TABLE memories ALTER COLUMN embedding TYPE vector(256);

-- Recreate tuned partial HNSW index (matches 006_performance_indexes.sql design)
CREATE INDEX IF NOT EXISTS idx_memories_embedding ON memories
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE deleted_at IS NULL AND valid_until IS NULL AND embedding IS NOT NULL;

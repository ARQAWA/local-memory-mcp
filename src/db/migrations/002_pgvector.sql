-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Add embedding column to knowledge_entries
ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS embedding vector(256);

-- Vector similarity index (HNSW — works on empty tables, PGlite compatible)
CREATE INDEX IF NOT EXISTS idx_entries_embedding ON knowledge_entries
    USING hnsw (embedding vector_cosine_ops);

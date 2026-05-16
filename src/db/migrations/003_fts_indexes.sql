-- Full-text search index on title + content + summary
CREATE INDEX IF NOT EXISTS idx_entries_fts ON knowledge_entries
    USING GIN (to_tsvector('english', COALESCE(title, '') || ' ' || content || ' ' || COALESCE(summary, '')));

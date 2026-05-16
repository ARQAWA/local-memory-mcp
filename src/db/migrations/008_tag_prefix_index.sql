-- Performance index for tag-prefix queries (file:*, symbol:*, etc.)
-- Uses text_pattern_ops for efficient LIKE 'prefix%' queries.
-- Falls back to a plain btree index if text_pattern_ops is not available (e.g., some PGlite builds).
DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS idx_memory_tags_prefix ON memory_tags (tag text_pattern_ops);
EXCEPTION WHEN undefined_object OR feature_not_supported THEN
  CREATE INDEX IF NOT EXISTS idx_memory_tags_prefix ON memory_tags (tag);
END $$;

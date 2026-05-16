-- Migration 017: Backfill NULL embeddings from migration 010
--
-- Migration 010 (fix_embedding_dimension) cleared ALL embeddings to change
-- the vector column dimensions. However, it provided no
-- mechanism to regenerate them.
--
-- The actual backfill is handled at the application level:
--   1. On startup, the server detects NULL embeddings and logs a warning.
--   2. The `reembed_memories` admin tool can target NULL-only embeddings.
--   3. `engram doctor --fix` detects and repairs missing embeddings.
--
-- This migration is intentionally a no-op SQL file — it serves as a marker
-- that the backfill concern has been addressed in application code.

SELECT 1;

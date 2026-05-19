-- @no-transaction

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_entities_repository_name_trgm
  ON entities USING GIN (repository_id uuid_ops, name gin_trgm_ops);

DROP INDEX CONCURRENTLY IF EXISTS idx_entities_name_trgm;

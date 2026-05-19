-- @after-repository-normalization

UPDATE repositories
SET metadata = metadata - 'migration'
WHERE metadata ? 'migration';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repositories_no_migration_metadata'
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_no_migration_metadata
      CHECK (NOT (metadata ? 'migration'));
  END IF;
END $$;

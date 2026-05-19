-- @after-repository-normalization

UPDATE repositories
SET metadata = (metadata #>> '{}')::jsonb
WHERE jsonb_typeof(metadata) = 'string'
  AND (metadata #>> '{}') ~ '^\s*\{';

UPDATE repositories
SET metadata = '{}'::jsonb
WHERE jsonb_typeof(metadata) <> 'object';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'repositories_metadata_is_object'
  ) THEN
    ALTER TABLE repositories
      ADD CONSTRAINT repositories_metadata_is_object
      CHECK (jsonb_typeof(metadata) = 'object');
  END IF;
END $$;

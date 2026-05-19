-- @after-repository-normalization

DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM repositories
  WHERE root_path IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'repositories.root_path has % NULL rows after identity normalization', bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count
  FROM repositories
  WHERE root_hash LIKE 'legacy-%';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'repositories.root_hash has % legacy rows after identity normalization', bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count
  FROM repositories
  WHERE metadata ? 'adopted_from_legacy';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'repositories.metadata has % adopted_from_legacy rows after identity normalization', bad_count;
  END IF;
END $$;

ALTER TABLE repositories
  ALTER COLUMN root_path SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_root_hash_not_legacy') THEN
    ALTER TABLE repositories ADD CONSTRAINT repositories_root_hash_not_legacy
      CHECK (root_hash NOT LIKE 'legacy-%');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'repositories_no_adopted_legacy_metadata') THEN
    ALTER TABLE repositories ADD CONSTRAINT repositories_no_adopted_legacy_metadata
      CHECK (NOT (metadata ? 'adopted_from_legacy'));
  END IF;
END $$;

ALTER TABLE repositories VALIDATE CONSTRAINT repositories_root_hash_not_legacy;
ALTER TABLE repositories VALIDATE CONSTRAINT repositories_no_adopted_legacy_metadata;

DO $$
DECLARE
  bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count
  FROM repositories
  WHERE root_path IS NULL;
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'repositories.root_path has % NULL rows after identity hardening', bad_count;
  END IF;

  SELECT COUNT(*) INTO bad_count
  FROM repositories
  WHERE root_hash !~ '^[0-9a-f]{64}$';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'repositories.root_hash has % non-sha256 rows', bad_count;
  END IF;
END $$;

ALTER TABLE repositories
  ALTER COLUMN root_path SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'repositories'::regclass AND conname = 'repositories_root_hash_sha256'
  ) THEN
    ALTER TABLE repositories ADD CONSTRAINT repositories_root_hash_sha256
      CHECK (root_hash ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'repositories'::regclass AND conname = 'repositories_metadata_identity_kind'
  ) THEN
    ALTER TABLE repositories ADD CONSTRAINT repositories_metadata_identity_kind
      CHECK (metadata ? 'identity_kind' AND metadata->>'identity_kind' IN ('git', 'folder'));
  END IF;
END $$;

ALTER TABLE repositories VALIDATE CONSTRAINT repositories_root_hash_sha256;
ALTER TABLE repositories VALIDATE CONSTRAINT repositories_metadata_identity_kind;

DO $$
DECLARE
  redundant_fk RECORD;
BEGIN
  FOR redundant_fk IN
    SELECT conrelid::regclass::text AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND conrelid IN (
        'audit_log'::regclass,
        'entities'::regclass,
        'entity_relations'::regclass,
        'memories'::regclass,
        'memory_entities'::regclass,
        'memory_relations'::regclass,
        'memory_tags'::regclass
      )
      AND conname NOT IN (
        'audit_log_memory_repository_fkey',
        'fk_audit_log_repository',
        'fk_entities_repository',
        'entity_relations_memory_repository_fkey',
        'entity_relations_source_repository_fkey',
        'entity_relations_target_repository_fkey',
        'fk_memories_repository',
        'memories_supersedes_repository_fkey',
        'memory_entities_entity_repository_fkey',
        'memory_entities_memory_repository_fkey',
        'memory_relations_source_repository_fkey',
        'memory_relations_target_repository_fkey',
        'memory_tags_memory_repository_fkey'
      )
  LOOP
    EXECUTE format('ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I', redundant_fk.table_name, redundant_fk.conname);
  END LOOP;
END $$;

DO $$
DECLARE
  repository_check RECORD;
BEGIN
  FOR repository_check IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'repositories'::regclass
      AND contype = 'c'
      AND conname NOT IN (
        'repositories_metadata_is_object',
        'repositories_root_hash_sha256',
        'repositories_metadata_identity_kind'
      )
  LOOP
    EXECUTE format('ALTER TABLE repositories DROP CONSTRAINT IF EXISTS %I', repository_check.conname);
  END LOOP;

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

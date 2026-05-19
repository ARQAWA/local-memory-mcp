DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'memories'::regclass AND conname = 'knowledge_entries_supersedes_fkey'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'memories'::regclass AND conname = 'memories_supersedes_fkey'
  ) THEN
    ALTER TABLE memories RENAME CONSTRAINT knowledge_entries_supersedes_fkey TO memories_supersedes_fkey;
  END IF;
END $$;

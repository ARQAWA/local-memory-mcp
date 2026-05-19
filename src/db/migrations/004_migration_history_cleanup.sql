DELETE FROM _migrations
WHERE name NOT IN (
  '001_repository_schema.sql',
  '002_repository_cleanup.sql',
  '003_repository_constraint_names.sql',
  '004_migration_history_cleanup.sql',
  '005_repository_graph_hardening.sql',
  '006_repository_identity_hardening.sql',
  '007_repository_metadata_object_hardening.sql',
  '008_repository_metadata_cleanup.sql'
);

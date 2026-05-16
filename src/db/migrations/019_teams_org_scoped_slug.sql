-- Migration 019: Make team slugs org-scoped instead of globally unique.
-- Previously: UNIQUE(slug) — one slug per entire system.
-- After: UNIQUE(slug, org_id) — same slug allowed in different orgs.

-- Add org_id column to teams (default 'default' for existing rows)
ALTER TABLE teams ADD COLUMN IF NOT EXISTS org_id TEXT NOT NULL DEFAULT 'default';

-- Drop the old global unique constraint on slug
ALTER TABLE teams DROP CONSTRAINT IF EXISTS teams_slug_key;

-- Create the new composite unique constraint
ALTER TABLE teams ADD CONSTRAINT teams_slug_org_unique UNIQUE (slug, org_id);

-- Index for org_id lookups
CREATE INDEX IF NOT EXISTS idx_teams_org_id ON teams(org_id);

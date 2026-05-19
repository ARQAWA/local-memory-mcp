import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseError } from "../errors.js";
import { type RepositoryIdentity, resolveStdioIdentity, sha256, slugify } from "../services/git-identity.service.js";
import { logger } from "../services/logger.js";
import type { SqlProvider } from "../repositories/memory.repository.js";

type Sql = ReturnType<SqlProvider>;

export interface RepositoryIdentityRow {
  id: string;
  slug: string;
  name: string;
  root_path: string | null;
  root_hash: string;
}

export interface RepositoryNormalizationPlan {
  row: RepositoryIdentityRow;
  path: string;
  identity: RepositoryIdentity;
}

function splitRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/[,:]/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function defaultProjectSearchRoots(): string[] {
  return [
    ...splitRoots(process.env["LOCAL_MEMORY_PROJECT_ROOTS"]),
    ...splitRoots(process.env["LOCAL_MEMORY_REPOSITORY_ROOT"]),
    join(homedir(), "PycharmProjects"),
    join(homedir(), "Projects"),
    join(homedir(), "Developer"),
    join(homedir(), "Code"),
  ];
}

export function discoverProjectFolders(searchRoots = defaultProjectSearchRoots()): string[] {
  const seen = new Set<string>();
  const folders: string[] = [];
  for (const root of searchRoots) {
    const absoluteRoot = resolve(root);
    if (!existsSync(absoluteRoot)) continue;
    const candidates = [absoluteRoot];
    try {
      for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
        if (entry.isDirectory()) candidates.push(join(absoluteRoot, entry.name));
      }
    } catch {
      continue;
    }
    for (const candidate of candidates) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      folders.push(candidate);
    }
  }
  return folders;
}

export function buildRepositoryNormalizationPlan(
  rows: RepositoryIdentityRow[],
  folders = discoverProjectFolders(),
  resolveIdentity: (path: string) => RepositoryIdentity = (path) => resolveStdioIdentity(path).repository,
): RepositoryNormalizationPlan[] {
  return rows.map((row) => {
    const matches = folders.filter((folder) => slugify(basename(folder)) === row.slug);
    if (matches.length === 0) {
      throw new DatabaseError(`Cannot normalize repository ${row.slug}: no matching local project folder found`);
    }
    if (matches.length > 1) {
      throw new DatabaseError(
        `Cannot normalize repository ${row.slug}: multiple matching local project folders found: ${matches.join(", ")}`,
      );
    }
    const path = matches[0];
    if (!path) {
      throw new DatabaseError(`Cannot normalize repository ${row.slug}: matched folder is empty`);
    }
    return { row, path, identity: resolveIdentity(path) };
  });
}

export async function normalizeRepositoryIdentities(sql: Sql): Promise<void> {
  const rows = await sql<RepositoryIdentityRow[]>`
    SELECT id::text, slug, name, root_path, root_hash
    FROM repositories
    WHERE root_path IS NULL OR root_hash LIKE 'legacy-%' OR metadata ? 'adopted_from_legacy'
    ORDER BY slug
  `;
  if (rows.length === 0) return;

  const plan = buildRepositoryNormalizationPlan(rows);
  for (const item of plan) {
    const collision = await sql<{ id: string; slug: string }[]>`
      SELECT id::text, slug
      FROM repositories
      WHERE root_hash = ${item.identity.repository_root_hash}
        AND id <> ${item.row.id}
      LIMIT 1
    `;
    const existing = collision[0];
    if (existing) {
      throw new DatabaseError(
        `Cannot normalize repository ${item.row.slug}: root hash collides with ${existing.slug} (${existing.id})`,
      );
    }

    await sql`
      UPDATE repositories
      SET root_path = ${item.identity.repository_root},
          root_hash = ${item.identity.repository_root_hash},
          remote_url_hash = ${item.identity.repository_remote_url_hash ?? null},
          metadata = ${sql.json(cleanRepositoryMetadata(item.identity))}::jsonb,
          updated_at = now(),
          last_seen_at = now()
      WHERE id = ${item.row.id}
    `;
    logger.info("Normalized repository identity", {
      slug: item.row.slug,
      root: item.identity.repository_root,
      kind: item.identity.repository_identity_kind,
      root_hash: item.identity.repository_root_hash.slice(0, 12),
    });
  }
}

export async function assertRepositoryIdentitiesClean(sql: Sql): Promise<void> {
  const [row] = await sql<{ count: string }[]>`
    SELECT COUNT(*)::text AS count
    FROM repositories
    WHERE root_path IS NULL OR root_hash LIKE 'legacy-%' OR metadata ? 'adopted_from_legacy'
  `;
  const count = Number(row?.count ?? 0);
  if (count > 0) {
    throw new DatabaseError(`Repository identity normalization left ${count} unclean rows`);
  }
}

export function cleanRepositoryMetadata(identity: RepositoryIdentity): Record<string, string> {
  return { identity_kind: identity.repository_identity_kind };
}

export function targetRootHash(path: string): string {
  return sha256(path);
}

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse } from "node:path";
import { LRUCache } from "lru-cache";

export type ProjectIdentityKind = "git" | "folder";

export interface RepositoryIdentity {
  repository_slug: string;
  repository_name: string;
  repository_root: string;
  repository_root_hash: string;
  repository_remote_url_hash?: string | undefined;
  repository_identity_kind: ProjectIdentityKind;
}

export interface StdioIdentity {
  repository: RepositoryIdentity;
  user_id: string;
  role: "admin" | "writer" | "reader";
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new LRUCache<string, StdioIdentity>({ max: 100, ttl: CACHE_TTL_MS });

export function resetGitIdentityCache(): void {
  cache.clear();
}

function execGit(args: string[], cwd?: string): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function extractRepoName(remoteUrl: string): string | undefined {
  const match = /[:/]([^/]+?)(?:\.git)?$/.exec(remoteUrl);
  return match?.[1];
}

export function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
  return slug || "repository";
}

const projectRootMarkers = [
  ".ai",
  ".idea",
  "pyproject.toml",
  "package.json",
  "pnpm-workspace.yaml",
  "Cargo.toml",
  "go.mod",
  "requirements.txt",
  "README.md",
] as const;

function canonicalDirectory(path: string): string {
  const real = realpathSync(path);
  const stat = statSync(real);
  return stat.isDirectory() ? real : dirname(real);
}

function hasProjectMarker(path: string): boolean {
  return projectRootMarkers.some((marker) => existsSync(join(path, marker)));
}

function findFolderProjectRoot(cwd: string): string {
  const start = canonicalDirectory(cwd);
  let current = start;
  const root = parse(start).root;
  while (true) {
    if (hasProjectMarker(current)) return current;
    if (current === root) return start;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function resolveProjectRoot(cwd: string): { root: string; kind: ProjectIdentityKind } {
  const repoRoot = execGit(["rev-parse", "--show-toplevel"], cwd);
  if (repoRoot) return { root: canonicalDirectory(repoRoot), kind: "git" };
  return { root: findFolderProjectRoot(cwd), kind: "folder" };
}

export function resolveStdioIdentity(cwd?: string): StdioIdentity {
  const effectiveCwd = process.env["LOCAL_MEMORY_REPOSITORY_ROOT"] ?? cwd ?? process.cwd();
  const cached = cache.get(effectiveCwd);
  if (cached) return cached;

  const project = resolveProjectRoot(effectiveCwd);
  const remoteUrl = project.kind === "git" ? execGit(["remote", "get-url", "origin"], project.root) : undefined;
  const remoteName = remoteUrl ? extractRepoName(remoteUrl) : undefined;
  const rawName = remoteName ?? basename(project.root);
  const userId =
    process.env["LOCAL_MEMORY_USER"] ??
    execGit(["config", "user.name"], project.root) ??
    "local-user";
  const roleEnv = process.env["LOCAL_MEMORY_ROLE"];
  const validRoles = ["admin", "writer", "reader"] as const;

  const identity: StdioIdentity = {
    repository: {
      repository_slug: slugify(rawName),
      repository_name: rawName,
      repository_root: project.root,
      repository_root_hash: sha256(project.root),
      repository_remote_url_hash: remoteUrl ? sha256(remoteUrl) : undefined,
      repository_identity_kind: project.kind,
    },
    user_id: userId,
    role: validRoles.includes(roleEnv as (typeof validRoles)[number])
      ? (roleEnv as (typeof validRoles)[number])
      : "admin",
  };

  cache.set(effectiveCwd, identity);
  return identity;
}

export function tryResolveStdioIdentity(cwd?: string): StdioIdentity | undefined {
  try {
    return resolveStdioIdentity(cwd);
  } catch {
    return undefined;
  }
}

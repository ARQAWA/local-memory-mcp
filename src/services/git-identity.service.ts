import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { LRUCache } from "lru-cache";
import { z } from "zod";

export interface StdioIdentity {
  org_id: string;
  team_slug?: string | undefined;
  user_id: string;
  role: "admin" | "writer" | "reader";
  repo_tags: string[];
}

/** Schema for ~/.engram/config.json (global config). */
const globalConfigSchema = z
  .object({
    org_id: z.string().min(1).optional(),
    team_slug: z.string().min(1).optional(),
    user_id: z.string().min(1).optional(),
    sync_personal_to_cloud: z.boolean().optional(),
    sync_url: z.url().optional(),
  })
  .strict();

/** Schema for .engram.json (per-repo config). */
const repoConfigSchema = z
  .object({
    org_id: z.string().min(1).optional(),
    team_slug: z.string().min(1).optional(),
    user_id: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new LRUCache<string, StdioIdentity>({
  max: 100,
  ttl: CACHE_TTL_MS,
});

export function resetGitIdentityCache(): void {
  cache.clear();
}

function execGit(args: string, cwd?: string): string | undefined {
  try {
    return execFileSync("git", args.split(/\s+/), {
      cwd,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

function readConfigFile<T>(filePath: string, schema: z.ZodType<T>): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf-8");
  } catch {
    return undefined; // file doesn't exist
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.warn(`[engram] Invalid JSON in ${filePath}, skipping`);
    return undefined;
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    console.warn(`[engram] Invalid config in ${filePath}: ${result.error.issues.map((i) => i.message).join(", ")}`);
    return undefined;
  }
  return result.data;
}

function extractRepoName(remoteUrl: string): string | undefined {
  // Handle SSH: git@github.com:org/repo.git
  const sshMatch = /[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(remoteUrl);
  if (sshMatch?.[1]) {
    const parts = sshMatch[1].split("/");
    return parts[parts.length - 1];
  }
  return undefined;
}

/**
 * Read the sync_personal_to_cloud preference from ~/.engram/config.json.
 * Returns false if the config file is missing or the field is unset.
 */
export function getSyncPersonalPreference(): boolean {
  const globalConfig = readConfigFile(join(homedir(), ".engram", "config.json"), globalConfigSchema);
  return globalConfig?.sync_personal_to_cloud ?? false;
}

export function resolveStdioIdentity(cwd?: string): StdioIdentity {
  const effectiveCwd = cwd ?? process.cwd();

  // Check cache
  const cached = cache.get(effectiveCwd);
  if (cached !== undefined) {
    return cached;
  }

  // 1. Environment variables (highest priority)
  const envOrg = process.env["ENGRAM_ORG"];
  const envTeam = process.env["ENGRAM_TEAM"];
  const envUser = process.env["ENGRAM_USER"];

  // 2. Find repo root for .engram.json
  const repoRoot = execGit("rev-parse --show-toplevel", effectiveCwd);
  const repoConfig = repoRoot ? readConfigFile(join(repoRoot, ".engram.json"), repoConfigSchema) : undefined;

  // 3. Global config ~/.engram/config.json
  const globalConfig = readConfigFile(join(homedir(), ".engram", "config.json"), globalConfigSchema);

  // 4. Git fallbacks
  const gitUserName = execGit("config user.name", effectiveCwd);

  // Resolve each field independently (first non-empty wins)
  const org_id = envOrg ?? repoConfig?.org_id ?? globalConfig?.org_id ?? "local";
  const team_slug = envTeam ?? repoConfig?.team_slug ?? globalConfig?.team_slug ?? undefined;
  const user_id = envUser ?? repoConfig?.user_id ?? globalConfig?.user_id ?? gitUserName ?? "local-user";

  // Build repo tags
  const repo_tags: string[] = [];

  // Auto-tag from git remote
  const remoteUrl = execGit("remote get-url origin", effectiveCwd);
  if (remoteUrl) {
    const repoName = extractRepoName(remoteUrl);
    if (repoName) {
      repo_tags.push(`repo:${repoName}`);
    }
  }

  // Merge tags from .engram.json
  if (repoConfig?.tags) {
    for (const tag of repoConfig.tags) {
      if (!repo_tags.includes(tag)) {
        repo_tags.push(tag);
      }
    }
  }

  const roleEnv = process.env["ENGRAM_ROLE"];
  const validRoles = ["admin", "writer", "reader"] as const;
  const role = validRoles.includes(roleEnv as (typeof validRoles)[number])
    ? (roleEnv as (typeof validRoles)[number])
    : "admin";

  const identity: StdioIdentity = {
    org_id,
    team_slug,
    user_id,
    role,
    repo_tags,
  };

  // Cache the result
  cache.set(effectiveCwd, identity);

  return identity;
}

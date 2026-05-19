import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { resetGitIdentityCache, resolveStdioIdentity, sha256 } from "../../src/services/git-identity.service.js";

const tempRoots: string[] = [];

function tempProject(name: string): string {
  const root = mkdtempSync(join(tmpdir(), `local-memory-${name}-`));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  delete process.env["LOCAL_MEMORY_REPOSITORY_ROOT"];
  resetGitIdentityCache();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("project identity resolution", () => {
  test("resolves a plain folder project without Git", () => {
    const root = tempProject("folder");
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'plain-folder'\n");

    const identity = resolveStdioIdentity(join(root, "src", "nested")).repository;
    const realRoot = realpathSync(root);

    expect(identity.repository_identity_kind).toBe("folder");
    expect(identity.repository_root).toBe(realRoot);
    expect(identity.repository_root_hash).toBe(sha256(realRoot));
    expect(identity.repository_remote_url_hash).toBeUndefined();
  });

  test("keeps the same root hash when a folder becomes a Git repository", () => {
    const root = tempProject("transition");
    writeFileSync(join(root, "pyproject.toml"), "[project]\nname = 'transition'\n");

    const folderIdentity = resolveStdioIdentity(root).repository;
    resetGitIdentityCache();
    execFileSync("git", ["init"], { cwd: root, stdio: ["ignore", "ignore", "ignore"] });
    const gitIdentity = resolveStdioIdentity(root).repository;

    expect(folderIdentity.repository_identity_kind).toBe("folder");
    expect(gitIdentity.repository_identity_kind).toBe("git");
    expect(gitIdentity.repository_root).toBe(folderIdentity.repository_root);
    expect(gitIdentity.repository_root_hash).toBe(folderIdentity.repository_root_hash);
  });
});

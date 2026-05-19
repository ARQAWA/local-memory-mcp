import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildRepositoryNormalizationPlan, discoverProjectFolders } from "../../src/db/repository-normalization.js";
import { sha256, slugify, type RepositoryIdentity } from "../../src/services/git-identity.service.js";

const tempRoots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "local-memory-normalize-"));
  tempRoots.push(root);
  return root;
}

function identityFor(path: string): RepositoryIdentity {
  return {
    repository_slug: slugify(basename(path)),
    repository_name: basename(path),
    repository_root: path,
    repository_root_hash: sha256(path),
    repository_identity_kind: "folder",
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("repository identity normalization planning", () => {
  test("maps an old placeholder row to exactly one folder", () => {
    const root = tempRoot();
    const project = join(root, "csg_routine");
    mkdirSync(project);
    writeFileSync(join(project, "pyproject.toml"), "[project]\nname = 'csg-routine'\n");

    const folders = discoverProjectFolders([root]);
    const plan = buildRepositoryNormalizationPlan(
      [
        {
          id: "cf5ad002-ebf5-42e3-8f1b-2325c9d676a5",
          slug: "csg_routine",
          name: "CSG Routine",
          root_path: null,
          root_hash: "legacy-csg-routine",
        },
      ],
      folders,
      identityFor,
    );

    expect(plan).toHaveLength(1);
    expect(plan[0]?.row.slug).toBe("csg_routine");
    expect(plan[0]?.path).toBe(project);
    expect(plan[0]?.identity.repository_root_hash).toBe(sha256(project));
  });

  test("fails when a placeholder row has multiple folder matches", () => {
    const rootA = tempRoot();
    const rootB = tempRoot();
    mkdirSync(join(rootA, "superbot"));
    mkdirSync(join(rootB, "superbot"));

    const folders = [...discoverProjectFolders([rootA]), ...discoverProjectFolders([rootB])];

    expect(() =>
      buildRepositoryNormalizationPlan(
        [
          {
            id: "59a219d1-3e21-4456-9c89-862bf06d0d23",
            slug: "superbot",
            name: "SuperBot",
            root_path: null,
            root_hash: "legacy-superbot",
          },
        ],
        folders,
        identityFor,
      ),
    ).toThrow(/multiple matching local project folders/);
  });
});

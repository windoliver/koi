import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MANIFEST_CANDIDATES, resolveManifestPath } from "./resolve-manifest-path.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "koi-manifest-test-"));
}

/** Creates a minimal valid git admin directory at `dir/.git` (HEAD + objects/). */
function makeGitDir(dir: string): void {
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(join(dir, ".git", "objects"));
}

describe("resolveManifestPath", () => {
  let tmp: string;

  beforeEach(() => {
    // Resolve symlinks so path-prefix assertions work on macOS (/var → /private/var).
    tmp = realpathSync(makeTmpDir());
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe("--no-manifest", () => {
    it("returns undefined without searching when noManifest=true", () => {
      const result = resolveManifestPath(tmp, undefined, true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBeUndefined();
        expect(result.searched).toHaveLength(0);
      }
    });

    it("ignores flagValue when noManifest=true", () => {
      const result = resolveManifestPath(tmp, "/nonexistent/koi.yaml", true);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBeUndefined();
      }
    });
  });

  describe("explicit --manifest flag", () => {
    it("returns absolute path when file exists", () => {
      const manifestPath = join(tmp, "koi.yaml");
      writeFileSync(manifestPath, "model:\n  name: claude\n");

      const result = resolveManifestPath(tmp, manifestPath);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(manifestPath);
      }
    });

    it("resolves relative path against cwd", () => {
      const manifestPath = join(tmp, "koi.yaml");
      writeFileSync(manifestPath, "model:\n  name: claude\n");

      const result = resolveManifestPath(tmp, "koi.yaml");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(manifestPath);
      }
    });

    it("errors when explicit file does not exist", () => {
      const result = resolveManifestPath(tmp, "/nonexistent/koi.yaml");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("/nonexistent/koi.yaml");
      }
    });

    it("does NOT fall back to discovery when explicit path missing", () => {
      // Even if koi.yaml exists in cwd, explicit missing path should error
      writeFileSync(join(tmp, "koi.yaml"), "model:\n  name: claude\n");
      const result = resolveManifestPath(tmp, "/nonexistent/koi.yaml");
      expect(result.ok).toBe(false);
    });

    it("returns error when explicit path is unreadable (EACCES), not 'not found'", () => {
      // lstatSync raises EACCES when a directory component lacks execute permission,
      // not when the file itself lacks read permission. Put the manifest in a subdir
      // and remove the subdir's execute bit so lstatSync throws EACCES.
      const subdir = join(tmp, "configs");
      mkdirSync(subdir);
      const manifestPath = join(subdir, "koi.yaml");
      writeFileSync(manifestPath, "model:\n  name: claude\n");
      chmodSync(subdir, 0o000);
      try {
        const result = resolveManifestPath(tmp, manifestPath);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.error).toContain("EACCES");
        }
      } finally {
        chmodSync(subdir, 0o755);
      }
    });
  });

  describe("auto-discovery", () => {
    it.each([...MANIFEST_CANDIDATES])("finds %s in cwd", (candidate: string) => {
      const parts = candidate.split("/");
      const dir = parts[0];
      if (parts.length > 1 && dir !== undefined) {
        mkdirSync(join(tmp, dir), { recursive: true });
      }
      const fullPath = join(tmp, ...parts);
      writeFileSync(fullPath, "model:\n  name: claude\n");

      const result = resolveManifestPath(tmp, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(fullPath);
      }
    });

    it("respects candidate precedence — koi.yaml wins over koi.manifest.yaml", () => {
      writeFileSync(join(tmp, "koi.yaml"), "model:\n  name: alpha\n");
      writeFileSync(join(tmp, "koi.manifest.yaml"), "model:\n  name: beta\n");

      const result = resolveManifestPath(tmp, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(join(tmp, "koi.yaml"));
      }
    });

    it("walks up to parent directory when cwd has no manifest", () => {
      makeGitDir(tmp);

      const parentManifest = join(tmp, "koi.yaml");
      writeFileSync(parentManifest, "model:\n  name: claude\n");

      const child = join(tmp, "sub", "project");
      mkdirSync(child, { recursive: true });

      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(parentManifest);
      }
    });

    it("returns undefined when no manifest found anywhere", () => {
      const result = resolveManifestPath(tmp, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBeUndefined();
      }
    });

    it("does not walk above cwd when no project boundary is present", () => {
      // Without .git or manifest-bearing .koi/, discovery is bounded to cwd.
      // Walking to filesystem root would silently apply an unrelated ancestor
      // manifest from a shared workspace, home dir, or container root.
      // Markerless projects must run from the project root or use --manifest.
      const child = join(tmp, "src");
      mkdirSync(child);
      writeFileSync(join(tmp, "koi.yaml"), "model:\n  name: should-not-find\n");

      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBeUndefined();
        expect(result.searched.every((p) => p.startsWith(child))).toBe(true);
      }
    });

    it("populates searched list with tried paths when nothing found", () => {
      const child = join(tmp, "sub");
      mkdirSync(child);

      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // At minimum, all 4 candidate names were tried in child
        expect(result.searched.length).toBeGreaterThanOrEqual(MANIFEST_CANDIDATES.length);
        // Every searched path includes a candidate filename
        const names = MANIFEST_CANDIDATES.map((c) => c.split("/").at(-1) ?? c);
        expect(result.searched.every((p) => names.some((n) => p.endsWith(n)))).toBe(true);
      }
    });

    it("stops at git root and does not walk further", () => {
      makeGitDir(tmp);

      const child = join(tmp, "src", "app");
      mkdirSync(child, { recursive: true });

      // No manifest anywhere under tmp — discovery should find nothing
      // and must not escape above the git root.
      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBeUndefined();
        // All searched paths must be within the git root (tmp) subtree
        expect(result.searched.every((p) => p.startsWith(tmp))).toBe(true);
      }
    });

    it("rejects a symlink that escapes the git root boundary", () => {
      makeGitDir(tmp);

      // Create a second isolated tmpdir with a manifest (simulates another project).
      const outsideDir = realpathSync(mkdtempSync(join(tmpdir(), "koi-outside-")));
      const outsideManifest = join(outsideDir, "secret.yaml");
      writeFileSync(outsideManifest, "model:\n  name: should-not-load\n");

      try {
        // Plant a symlink inside the repo pointing to the outside manifest.
        symlinkSync(outsideManifest, join(tmp, "koi.yaml"));

        const result = resolveManifestPath(tmp, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // The symlink must be skipped; no manifest is returned.
          expect(result.path).toBeUndefined();
        }
      } finally {
        rmSync(outsideDir, { recursive: true, force: true });
      }
    });

    it("accepts a symlink that resolves inside the git root boundary", () => {
      makeGitDir(tmp);

      const realManifest = join(tmp, "configs", "koi.yaml");
      mkdirSync(join(tmp, "configs"));
      writeFileSync(realManifest, "model:\n  name: claude\n");

      // Symlink at root of repo points to the real file inside the same tree.
      symlinkSync(realManifest, join(tmp, "koi.yaml"));

      const result = resolveManifestPath(tmp, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // The original symlink path is returned so that loadManifestConfig
        // anchors relative policy/filesystem references to the symlink location,
        // matching --manifest ./koi.yaml semantics exactly.
        expect(result.path).toBe(join(tmp, "koi.yaml"));
      }
    });

    it("discovers manifest when cwd is entered via a symlinked directory", () => {
      makeGitDir(tmp);

      const realDir = join(tmp, "real-subdir");
      mkdirSync(realDir);

      // Symlink → real subdirectory
      const linkDir = join(tmp, "link-subdir");
      symlinkSync(realDir, linkDir);

      // Manifest at the git root
      const manifest = join(tmp, "koi.yaml");
      writeFileSync(manifest, "model:\n  name: claude\n");

      // Enter through the symlink — must still walk up and find the manifest
      const result = resolveManifestPath(linkDir, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(manifest);
      }
    });

    it("rejects a regular manifest outside the canonical stopAt reached through a symlinked cwd", () => {
      // If realpathSync fails for cwd but findProjectRoot succeeds canonically,
      // current in the walk would be a non-canonical symlink path. A regular file
      // at join(current, candidate) must still be checked against the canonical
      // stopAt via realpathSync — not simply returned because it is not a symlink.
      // This simulates the mismatch by using a symlinked project root directory.
      const realProject = realpathSync(mkdtempSync(join(tmpdir(), "koi-real-proj-")));
      makeGitDir(realProject);
      writeFileSync(join(realProject, "koi.yaml"), "model:\n  name: real\n");

      const linkProject = join(tmp, "link-project");
      symlinkSync(realProject, linkProject);

      // Enter through the symlink — cwd before realpathSync is linkProject.
      // realpathSync resolves it to realProject. Discovery must find the manifest.
      const result = resolveManifestPath(linkProject, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Manifest is inside the canonical project root — must be accepted.
        expect(result.path).toBe(join(realProject, "koi.yaml"));
      }
      rmSync(realProject, { recursive: true, force: true });
    });

    it("discovers manifest when cwd is inside a symlinked repo root (symlinked ancestor)", () => {
      // Regression: cwd entered via a symlinked ancestor directory must still
      // discover the manifest at the project root. canonicalCwd = realpathSync(cwd)
      // gives a canonical path, so containment comparisons are always canonical→canonical.
      const realProject = realpathSync(mkdtempSync(join(tmpdir(), "koi-sym-anc-")));
      makeGitDir(realProject);
      writeFileSync(join(realProject, "koi.yaml"), "model:\n  name: real\n");

      const linkProject = join(tmp, "link-repo");
      symlinkSync(realProject, linkProject);

      // cwd is inside the symlinked root, not the root itself.
      const subdir = join(realProject, "src");
      mkdirSync(subdir);

      try {
        // Enter through symlinked root then descend into the real subdir.
        const cwdViaLink = join(linkProject, "src");
        const result = resolveManifestPath(cwdViaLink, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Must walk up and find the manifest at the canonical project root.
          expect(result.path).toBe(join(realProject, "koi.yaml"));
          expect(result.insideProject).toBe(true);
        }
      } finally {
        rmSync(realProject, { recursive: true, force: true });
      }
    });

    it("walks up to parent when .koi/ contains a manifest (non-git boundary)", () => {
      // A .koi/ dir with a manifest file marks the project root.
      mkdirSync(join(tmp, ".koi"));
      writeFileSync(join(tmp, ".koi", "koi.yaml"), "model:\n  name: claude\n");

      // Also place a root-level manifest (higher candidate precedence).
      const parentManifest = join(tmp, "koi.yaml");
      writeFileSync(parentManifest, "model:\n  name: claude\n");

      const child = join(tmp, "subproject", "src");
      mkdirSync(child, { recursive: true });

      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Walks up to tmp boundary, finds root koi.yaml (higher priority).
        expect(result.path).toBe(parentManifest);
      }
    });

    it("does not walk above the .koi/ boundary into unrelated parent dirs", () => {
      // .koi/ with manifest at tmp = project root.
      mkdirSync(join(tmp, ".koi"));
      writeFileSync(join(tmp, ".koi", "koi.yaml"), "model:\n  name: project\n");

      // Manifest one level ABOVE tmp — must NOT be discovered.
      const outerDir = realpathSync(mkdtempSync(join(tmpdir(), "koi-outer-")));
      writeFileSync(join(outerDir, "koi.yaml"), "model:\n  name: should-not-load\n");

      try {
        const child = join(tmp, "src");
        mkdirSync(child);

        const result = resolveManifestPath(child, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // All searched paths must be within tmp subtree
          expect(result.searched.every((p) => p.startsWith(tmp))).toBe(true);
        }
      } finally {
        rmSync(outerDir, { recursive: true, force: true });
      }
    });

    it("does not treat a .koi/ dir with a symlinked manifest as a project boundary", () => {
      // A nested subtree can plant .koi/koi.yaml as a symlink pointing outside
      // its own tree. This must NOT stop the upward walk — boundary detection
      // only counts regular files (no symlink following).
      const outsideFile = realpathSync(mkdtempSync(join(tmpdir(), "koi-outside-")));
      const outsideManifest = join(outsideFile, "manifest.yaml");
      writeFileSync(outsideManifest, "model:\n  name: should-not-be-boundary\n");

      // Real git root at a parent level.
      const outerDir = realpathSync(mkdtempSync(join(tmpdir(), "koi-outer-sym-")));
      makeGitDir(outerDir);
      writeFileSync(join(outerDir, "koi.yaml"), "model:\n  name: real\n");

      try {
        const child = join(outerDir, "nested");
        mkdirSync(child);
        mkdirSync(join(child, ".koi"));
        // Symlink: .koi/koi.yaml → outside file
        symlinkSync(outsideManifest, join(child, ".koi", "koi.yaml"));

        // nested/src is the cwd
        const src = join(child, "src");
        mkdirSync(src);
        const result = resolveManifestPath(src, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // The symlinked .koi boundary was rejected; the real git-root manifest found.
          expect(result.path).toBe(join(outerDir, "koi.yaml"));
          expect(result.insideProject).toBe(true);
        }
      } finally {
        rmSync(outsideFile, { recursive: true, force: true });
        rmSync(outerDir, { recursive: true, force: true });
      }
    });

    it("does not treat a bare .koi/ without a manifest as a project boundary", () => {
      // A .koi/ directory with only runtime artifacts (plans, sessions) must
      // NOT stop the walk — incidental dirs created by koi at runtime should
      // not shadow a higher-level project manifest.
      const outerDir = realpathSync(mkdtempSync(join(tmpdir(), "koi-outer-")));
      makeGitDir(outerDir);
      const outerManifest = join(outerDir, "koi.yaml");
      writeFileSync(outerManifest, "model:\n  name: outer\n");

      try {
        const child = join(outerDir, "src");
        mkdirSync(child);
        // Incidental .koi/ with no manifest (simulates .koi/plans, .koi/sessions, etc.)
        mkdirSync(join(child, ".koi", "plans"), { recursive: true });

        const result = resolveManifestPath(child, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          // Must walk past the bare .koi/ and find the outer manifest.
          expect(result.path).toBe(outerManifest);
        }
      } finally {
        rmSync(outerDir, { recursive: true, force: true });
      }
    });

    it("does not require a git binary — .git dir with HEAD + objects/ is sufficient for boundary", () => {
      // This test intentionally uses only filesystem artifacts, not `git init`.
      // A .git/ dir with HEAD + objects/ is the minimal valid marker — no git
      // binary is needed. If the implementation required the git binary it would
      // fall back to cwd-only and NOT find the manifest in the parent.
      makeGitDir(tmp);

      const parentManifest = join(tmp, "koi.yaml");
      writeFileSync(parentManifest, "model:\n  name: claude\n");

      const child = join(tmp, "nested");
      mkdirSync(child);

      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Must have walked up from child to tmp to find the manifest.
        expect(result.path).toBe(parentManifest);
      }
    });

    it("does not treat a .git dir with HEAD but without objects/ as a project boundary", () => {
      // A .git dir with only HEAD (no objects/) is rejected. This prevents a trivial
      // `mkdir .git && touch .git/HEAD` forgery from shadowing the real parent manifest.
      const child = join(tmp, "sub");
      mkdirSync(child);
      mkdirSync(join(child, ".git"));
      writeFileSync(join(child, ".git", "HEAD"), "ref: refs/heads/main\n");
      // No objects/ — should not qualify as a boundary.

      // Real parent boundary via .koi manifest.
      mkdirSync(join(tmp, ".koi"));
      writeFileSync(join(tmp, ".koi", "koi.yaml"), "model:\n  name: real\n");
      const realManifest = join(tmp, ".koi", "koi.yaml");

      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(realManifest);
      }
    });

    it("does not treat a bare empty .git directory as a project boundary", () => {
      // An empty .git dir (no HEAD) is not a valid git marker and must not
      // stop the upward walk — prevents decoy dirs from shadowing real manifests.
      const child = join(tmp, "sub");
      mkdirSync(child);
      mkdirSync(join(child, ".git")); // no HEAD — invalid marker

      // Manifest one level above child — must still be discoverable via .koi
      mkdirSync(join(tmp, ".koi"));
      writeFileSync(join(tmp, ".koi", "koi.yaml"), "model:\n  name: real\n");
      const realManifest = join(tmp, "koi.yaml");
      writeFileSync(realManifest, "model:\n  name: real\n");

      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Walk must not stop at the invalid .git in child; real boundary at tmp found
        expect(result.path).toBe(realManifest);
      }
    });

    it("accepts a git worktree .git file as a valid boundary", () => {
      // git worktrees use a .git FILE (not dir) starting with "gitdir:".
      // The target must have HEAD + commondir + a gitdir back-reference pointing
      // back to the worktree's .git file.
      const worktreeDir = join(tmp, "worktree");
      mkdirSync(worktreeDir);
      const worktreesDir = join(tmp, ".git", "worktrees", "feat");
      mkdirSync(worktreesDir, { recursive: true });
      writeFileSync(join(worktreesDir, "HEAD"), "ref: refs/heads/feat\n");
      writeFileSync(join(worktreesDir, "commondir"), "../../\n");
      // Back-reference: points to the worktree's .git file.
      writeFileSync(join(worktreesDir, "gitdir"), join(worktreeDir, ".git"));

      writeFileSync(join(worktreeDir, ".git"), `gitdir: ${worktreesDir}\n`);
      const manifest = join(worktreeDir, "koi.yaml");
      writeFileSync(manifest, "model:\n  name: claude\n");

      const result = resolveManifestPath(worktreeDir, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(manifest);
        expect(result.insideProject).toBe(true);
      }
    });

    it("accepts a git submodule .git file as a valid boundary", () => {
      // Git submodules use a .git FILE like linked worktrees, but the target
      // directory is a standalone admin dir (HEAD + objects/) with no commondir.
      const gitModulesDir = join(tmp, ".git", "modules", "submod");
      mkdirSync(gitModulesDir, { recursive: true });
      writeFileSync(join(gitModulesDir, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(gitModulesDir, "objects"));

      const submodDir = join(tmp, "submod");
      mkdirSync(submodDir);
      writeFileSync(join(submodDir, ".git"), `gitdir: ${gitModulesDir}\n`);
      const manifest = join(submodDir, "koi.yaml");
      writeFileSync(manifest, "model:\n  name: claude\n");

      const result = resolveManifestPath(submodDir, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(manifest);
        expect(result.insideProject).toBe(true);
      }
    });

    it("does not apply parent manifest inside a git submodule (submodule is a boundary)", () => {
      // The superproject has koi.yaml; the submodule boundary must prevent it
      // from being loaded when running koi from inside the submodule.
      makeGitDir(tmp);
      writeFileSync(join(tmp, "koi.yaml"), "model:\n  name: parent\n");

      const gitModulesDir = join(tmp, ".git", "modules", "submod");
      mkdirSync(gitModulesDir, { recursive: true });
      writeFileSync(join(gitModulesDir, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(gitModulesDir, "objects"));

      const submodDir = join(tmp, "submod");
      mkdirSync(submodDir);
      writeFileSync(join(submodDir, ".git"), `gitdir: ${gitModulesDir}\n`);

      const child = join(submodDir, "src");
      mkdirSync(child);

      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Boundary found at submodule root; parent koi.yaml must not be loaded.
        expect(result.path).toBeUndefined();
        expect(result.insideProject).toBe(true);
      }
    });

    it("rejects a forged .git file whose target lacks commondir", () => {
      // A decoy .git file pointing to an arbitrary dir with HEAD (but no commondir)
      // must NOT act as a project boundary — real git worktree metadata always has
      // both HEAD and commondir. Without rejecting the decoy, nested dirs could
      // shadow a parent manifest by planting a fake .git file.
      const fakeTarget = join(tmp, "fake-git-meta");
      mkdirSync(fakeTarget);
      writeFileSync(join(fakeTarget, "HEAD"), "ref: refs/heads/main\n");
      // No commondir written — this is the decoy.

      // Real git root at tmp so the walk can continue past the decoy.
      makeGitDir(tmp);

      const nested = join(tmp, "nested");
      mkdirSync(nested);
      writeFileSync(join(nested, ".git"), `gitdir: ${fakeTarget}\n`);

      // Parent has a real koi.yaml; it should be found after the decoy is rejected.
      writeFileSync(join(tmp, "koi.yaml"), "model:\n  name: claude\n");

      const child = join(nested, "src");
      mkdirSync(child);

      // Discovery walks past the decoy boundary and finds the parent's koi.yaml.
      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(join(tmp, "koi.yaml"));
        expect(result.insideProject).toBe(true);
      }
    });

    it("accepts a submodule boundary inside a linked worktree (modules dir under superproject)", () => {
      // Linked worktree layout:
      //   main/.git/           ← real git admin dir
      //     worktrees/feat/    ← worktree metadata
      //     modules/submod/    ← submodule admin dir (no commondir)
      //   worktree/
      //     .git               ← "gitdir: main/.git/worktrees/feat"
      //     submod/
      //       .git             ← "gitdir: main/.git/modules/submod"
      //       koi.yaml         ← submodule manifest found
      const mainDir = join(tmp, "main");
      const mainGitDir = join(mainDir, ".git");
      mkdirSync(mainGitDir, { recursive: true });
      writeFileSync(join(mainGitDir, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(mainGitDir, "objects"));

      const wtMetaDir = join(mainGitDir, "worktrees", "feat");
      mkdirSync(wtMetaDir, { recursive: true });
      writeFileSync(join(wtMetaDir, "HEAD"), "ref: refs/heads/feat\n");
      writeFileSync(join(wtMetaDir, "commondir"), "../../\n");

      const worktreeDir = join(tmp, "worktree");
      mkdirSync(worktreeDir);
      // Back-reference for worktree validation.
      writeFileSync(join(wtMetaDir, "gitdir"), join(worktreeDir, ".git"));
      writeFileSync(join(worktreeDir, ".git"), `gitdir: ${wtMetaDir}\n`);

      // Superproject koi.yaml — must NOT bleed into the submodule.
      writeFileSync(join(mainDir, "koi.yaml"), "model:\n  name: parent\n");

      // Submodule admin dir under main's .git/modules/ (no commondir — submodule).
      const submodMetaDir = join(mainGitDir, "modules", "submod");
      mkdirSync(submodMetaDir, { recursive: true });
      writeFileSync(join(submodMetaDir, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(submodMetaDir, "objects"));

      const submodDir = join(worktreeDir, "submod");
      mkdirSync(submodDir);
      writeFileSync(join(submodDir, ".git"), `gitdir: ${submodMetaDir}\n`);

      const manifest = join(submodDir, "koi.yaml");
      writeFileSync(manifest, "model:\n  name: submod\n");

      // Running from inside the submodule — must find the submodule's own manifest.
      const result = resolveManifestPath(submodDir, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(manifest);
        expect(result.insideProject).toBe(true);
      }
    });

    it("does not bleed parent manifest into submodule inside a linked worktree", () => {
      // Same structure as above but no koi.yaml in the submodule.
      // Discovery must stop at the submodule boundary and return undefined,
      // NOT walk up through the linked worktree to the superproject manifest.
      const mainDir = join(tmp, "main");
      const mainGitDir = join(mainDir, ".git");
      mkdirSync(mainGitDir, { recursive: true });
      writeFileSync(join(mainGitDir, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(mainGitDir, "objects"));

      const wtMetaDir = join(mainGitDir, "worktrees", "feat");
      mkdirSync(wtMetaDir, { recursive: true });
      writeFileSync(join(wtMetaDir, "HEAD"), "ref: refs/heads/feat\n");
      writeFileSync(join(wtMetaDir, "commondir"), "../../\n");

      const worktreeDir = join(tmp, "worktree");
      mkdirSync(worktreeDir);
      writeFileSync(join(wtMetaDir, "gitdir"), join(worktreeDir, ".git"));
      writeFileSync(join(worktreeDir, ".git"), `gitdir: ${wtMetaDir}\n`);

      // Parent/superproject manifest.
      writeFileSync(join(mainDir, "koi.yaml"), "model:\n  name: parent\n");

      const submodMetaDir = join(mainGitDir, "modules", "submod");
      mkdirSync(submodMetaDir, { recursive: true });
      writeFileSync(join(submodMetaDir, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(submodMetaDir, "objects"));

      const submodDir = join(worktreeDir, "submod");
      mkdirSync(submodDir);
      writeFileSync(join(submodDir, ".git"), `gitdir: ${submodMetaDir}\n`);

      const child = join(submodDir, "src");
      mkdirSync(child);

      // Must stop at the submodule boundary; parent manifest must NOT be loaded.
      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBeUndefined();
        expect(result.insideProject).toBe(true);
      }
    });

    it("rejects a forged .git submodule file pointing at an arbitrary repo .git dir", () => {
      // A planted .git file can point at ANY real repo's .git dir (which has HEAD +
      // objects/) without going through .git/modules/. Before the modules-path check,
      // this would stop the walk at the nested dir, hiding the parent manifest.
      // After the fix: the no-commondir branch also requires the target be under an
      // ancestor's .git/modules/ — so the forgery is rejected.
      const fakeTarget = join(tmp, "real-looking-git");
      mkdirSync(fakeTarget);
      writeFileSync(join(fakeTarget, "HEAD"), "ref: refs/heads/main\n");
      mkdirSync(join(fakeTarget, "objects")); // has both HEAD + objects/ like a real repo

      // Real parent boundary via .git at tmp.
      makeGitDir(tmp);
      writeFileSync(join(tmp, "koi.yaml"), "model:\n  name: real\n");

      const nested = join(tmp, "nested");
      mkdirSync(nested);
      // Plant .git file pointing at the "real-looking" target outside .git/modules/
      writeFileSync(join(nested, ".git"), `gitdir: ${fakeTarget}\n`);

      const child = join(nested, "src");
      mkdirSync(child);

      // The forgery must be rejected; discovery continues to tmp and finds koi.yaml.
      const result = resolveManifestPath(child, undefined);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe(join(tmp, "koi.yaml"));
        expect(result.insideProject).toBe(true);
      }
    });

    it("returns error when .koi boundary directory is inaccessible (EACCES boundary failure)", () => {
      // lstatSync raises EACCES when a directory component lacks execute permission,
      // not when the file itself is unreadable. Remove execute bit from .koi/ so
      // lstatSync(".koi/koi.yaml") throws EACCES → boundary detection must fail closed,
      // not silently degrade to 'no project found' (which would drop manifest policy).
      const koiDir = join(tmp, ".koi");
      mkdirSync(koiDir);
      writeFileSync(join(koiDir, "koi.yaml"), "model:\n  name: claude\n");
      chmodSync(koiDir, 0o000);

      const child = join(tmp, "src");
      mkdirSync(child);

      try {
        const result = resolveManifestPath(child, undefined);
        expect(result.ok).toBe(false);
      } finally {
        chmodSync(koiDir, 0o755);
      }
    });

    it("returns error when manifest candidate directory is inaccessible (EACCES)", () => {
      // Removing execute bit from .koi/ causes lstatSync on .koi/koi.yaml to throw
      // EACCES (not ENOENT). The error must surface, not be silently skipped.
      makeGitDir(tmp);
      const koiDir = join(tmp, ".koi");
      mkdirSync(koiDir);
      writeFileSync(join(koiDir, "koi.yaml"), "model:\n  name: claude\n");
      chmodSync(koiDir, 0o000);
      try {
        const result = resolveManifestPath(tmp, undefined);
        expect(result.ok).toBe(false);
      } finally {
        chmodSync(koiDir, 0o755);
      }
    });

    describe("insideProject", () => {
      it("is true when .git boundary is present and manifest found", () => {
        makeGitDir(tmp);
        writeFileSync(join(tmp, "koi.yaml"), "model:\n  name: claude\n");
        const result = resolveManifestPath(tmp, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.insideProject).toBe(true);
        }
      });

      it("is true when .git boundary is present but no manifest found", () => {
        makeGitDir(tmp);
        const result = resolveManifestPath(tmp, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.path).toBeUndefined();
          expect(result.insideProject).toBe(true);
        }
      });

      it("is false when no project boundary is present", () => {
        // tmp is in OS tmpdir — no .git, no .koi/ with manifest.
        const result = resolveManifestPath(tmp, undefined);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.insideProject).toBe(false);
        }
      });

      it("is false for --no-manifest shortcut", () => {
        const result = resolveManifestPath(tmp, undefined, true);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.insideProject).toBe(false);
        }
      });

      it("is false for explicit --manifest path (no project walk performed)", () => {
        const p = join(tmp, "koi.yaml");
        writeFileSync(p, "model:\n  name: claude\n");
        const result = resolveManifestPath(tmp, p);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.insideProject).toBe(false);
        }
      });
    });
  });
});

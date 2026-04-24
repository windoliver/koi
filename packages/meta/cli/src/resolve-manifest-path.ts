import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export const MANIFEST_CANDIDATES = [
  "koi.yaml",
  "koi.manifest.yaml",
  ".koi/koi.yaml",
  ".koi/manifest.yaml",
] as const;

export type ManifestPathResult =
  | {
      readonly ok: true;
      readonly path: string | undefined;
      readonly searched: readonly string[];
      /** True when discovery walked inside a recognised project boundary (.git or
       *  manifest-bearing .koi/). Callers can use this to distinguish "searched a
       *  project and found nothing" (fail-close candidate) from "no project context,
       *  nothing searched beyond cwd" (backward-compat: fall through to defaults). */
      readonly insideProject: boolean;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Returns true if `p` exists (any filesystem type).
 * Unlike `existsSync`, propagates hard errors (EACCES, EPERM, ELOOP, EIO) so
 * callers can fail closed instead of treating an inaccessible path as absent.
 */
function pathExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

/**
 * Returns true if `dir/.koi/` contains at least one manifest candidate.
 * This prevents incidental `.koi/` runtime directories (e.g. `.koi/plans`,
 * `.koi/sessions`) from acting as false project-root boundaries.
 */
function koiDirHasManifest(dir: string): boolean {
  // Boundary detection must not follow symlinks — a nested subtree could plant a
  // .koi/koi.yaml symlink pointing outside its own tree to block discovery of the
  // real parent manifest. lstatSync().isFile() rejects symlinks.
  function isPlainFile(p: string): boolean {
    try {
      return lstatSync(p).isFile();
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw e;
    }
  }
  return (
    isPlainFile(join(dir, ".koi", "koi.yaml")) || isPlainFile(join(dir, ".koi", "manifest.yaml"))
  );
}

/**
 * Returns the canonical path to the `modules/` directory for a given `.git`
 * entry. Returns `undefined` when the path is not a recognisable git marker or
 * cannot be read (treated as "no modules dir at this level").
 *
 * - .git directory    → <gitPath>/modules/
 * - .git file (linked worktree) → follows commondir to the real admin dir →
 *   <commonDir>/modules/
 * - .git file (no commondir)    → <absTarget>/modules/
 *
 * Errors are swallowed so that an unreadable ancestor `.git` merely causes
 * isUnderAncestorModules to skip that level rather than surface an error at
 * the submodule containment check stage.
 */
function resolveGitModulesDir(gitPath: string): string | undefined {
  try {
    const stat = lstatSync(gitPath);
    if (stat.isDirectory()) return join(gitPath, "modules");
    if (stat.isFile()) {
      const content = readFileSync(gitPath, "utf8");
      if (!content.startsWith("gitdir:")) return undefined;
      const target = content.split("\n")[0]?.slice("gitdir:".length).trim();
      if (!target) return undefined;
      const absTarget = isAbsolute(target) ? target : resolve(dirname(gitPath), target);
      if (pathExists(join(absTarget, "commondir"))) {
        // Linked worktree — real admin dir is found through commondir.
        const raw = readFileSync(join(absTarget, "commondir"), "utf8").trim();
        const commonDir = isAbsolute(raw) ? raw : resolve(absTarget, raw);
        return join(commonDir, "modules");
      }
      return join(absTarget, "modules");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when `absTarget` (a resolved gitdir path from a `.git` file) is
 * located inside the `modules/` tree of an ancestor repository's git admin dir.
 * This is the canonical layout git uses for submodule embedded gitdirs. When an
 * ancestor `.git` is itself a worktree file, the real common git dir is followed
 * via commondir so that submodules inside linked worktrees are validated against
 * the superproject's `.git/modules/`, not the non-existent worktree `.git/modules/`.
 * A planted `.git` file pointing at an arbitrary repo's `.git` dir would fail
 * this check because that dir is not under any ancestor's modules/ path.
 */
function isUnderAncestorModules(absTarget: string, dir: string): boolean {
  let ancestor = dirname(dir);
  while (true) {
    const modulesDir = resolveGitModulesDir(join(ancestor, ".git"));
    if (modulesDir !== undefined && isInsideOrEqual(absTarget, modulesDir)) return true;
    const parent = dirname(ancestor);
    if (parent === ancestor) return false; // filesystem root
    ancestor = parent;
  }
}

/**
 * Returns true when the `.git` entry at `dir` is a genuine git repo marker:
 * - a directory containing a `HEAD` file (standard `git init`)
 * - a regular file starting with "gitdir:" pointing to an existing metadata
 *   directory that itself contains a `HEAD` file (git worktree / submodule)
 *
 * Bare/empty `.git` directories and stray `.git` files with invalid or
 * non-existent `gitdir:` targets are rejected so they cannot shadow a real
 * parent manifest. Hard filesystem errors (EACCES, EPERM, ELOOP) are
 * propagated so callers can fail closed instead of silently treating
 * permission failures as "no boundary found".
 */
function isValidGitMarker(dir: string): boolean {
  const gitPath = join(dir, ".git");
  try {
    const stat = lstatSync(gitPath);
    if (stat.isFile()) {
      const content = readFileSync(gitPath, "utf8");
      if (!content.startsWith("gitdir:")) return false;
      // Parse target path (first line, after "gitdir: ")
      const target = content.split("\n")[0]?.slice("gitdir:".length).trim();
      if (!target) return false;
      // Resolve relative to the directory containing the .git file.
      const absTarget = isAbsolute(target) ? target : resolve(dir, target);
      // Validate the target based on its layout:
      // - Linked worktree: has commondir (worktree-specific metadata). Also
      //   requires a gitdir back-reference pointing to our .git file.
      // - Submodule gitdir: no commondir. Has HEAD + objects/ like a regular repo.
      // - Forgery: no HEAD, or HEAD-only / commondir-only without the rest → rejected.
      if (!pathExists(join(absTarget, "HEAD"))) return false;
      if (pathExists(join(absTarget, "commondir"))) {
        // Linked worktree: gitdir back-reference must point back to our .git file.
        // Propagates hard errors (EACCES) so inaccessible metadata fails closed.
        const backRefRaw = readFileSync(join(absTarget, "gitdir"), "utf8").trim();
        const backRef = isAbsolute(backRefRaw) ? backRefRaw : resolve(absTarget, backRefRaw);
        return backRef === gitPath;
      }
      // Submodule gitdir: must live under an ancestor's .git/modules/ tree (git's
      // canonical submodule layout). This rejects planted .git files that point at
      // an arbitrary repo's .git dir (which also has HEAD + objects/) but is not
      // nested under any superproject's .git/modules/ path.
      if (!isUnderAncestorModules(absTarget, dir)) return false;
      return pathExists(join(absTarget, "objects"));
    }
    if (stat.isDirectory()) {
      // Require HEAD + objects/ to distinguish a real admin dir from a trivial
      // decoy (mkdir .git && touch .git/HEAD). Every real git repo has objects/.
      return pathExists(join(gitPath, "HEAD")) && pathExists(join(gitPath, "objects"));
    }
    return false;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

/**
 * Walks up from `start` (canonicalized) looking for a project boundary marker:
 * `.git` (git repo — dir or file for worktrees) or a `.koi/` directory that
 * contains a manifest candidate (koi project root for non-git deployments).
 * Only manifest-bearing `.koi/` directories qualify; incidental runtime
 * subdirectories (e.g. `.koi/plans`, `.koi/sessions`) do not.
 * Returns the first containing directory with either marker, or undefined.
 * Throws for hard filesystem errors so callers can distinguish "no project
 * found" from "degraded filesystem — cannot safely determine project root".
 * Pure filesystem; no git binary required.
 */
function findProjectRoot(start: string): string | undefined {
  // Canonicalize so that symlinked working directories still find real markers.
  let current: string;
  try {
    current = realpathSync(start);
  } catch {
    current = resolve(start);
  }
  while (true) {
    if (isValidGitMarker(current) || koiDirHasManifest(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return undefined; // filesystem root
    current = parent;
  }
}

/**
 * Returns true when `real` is the same path as `root` or a child of it.
 * Uses `path.relative` so it is separator-agnostic (POSIX and Windows).
 */
function isInsideOrEqual(real: string, root: string): boolean {
  const rel = relative(root, real);
  // rel === "" means same path; no leading ".." and not absolute means child.
  return !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Checks that `p` is a regular file (or a symlink to one), with no
 * containment restriction. Used for explicit --manifest paths where the
 * user explicitly opted into the path.
 */
function acceptRegularFile(p: string): string | undefined {
  try {
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) {
      const real = realpathSync(p);
      // Verify target is a regular file but return the original symlink path.
      // Callers (manifest loader) anchor relative references to dirname(path),
      // so canonicalizing here would silently redirect relative filesystem/policy
      // paths from the symlink location to the target's location.
      return lstatSync(real).isFile() ? p : undefined;
    }
    return stat.isFile() ? p : undefined;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e;
  }
}

/**
 * Accepts `p` only if it is a regular file (or a symlink whose resolved
 * target is a regular file inside `root`). Symlinks escaping `root` are
 * rejected so auto-discovery cannot be tricked into loading a manifest from
 * another project via a symlink planted inside the repo.
 *
 * Returns:
 *   - string  → accepted path
 *   - undefined → file absent (ENOENT / ENOTDIR — not an error, skip to next candidate)
 *
 * Throws for hard filesystem errors (EACCES, EPERM, ELOOP, EIO, etc.) so
 * callers can distinguish "does not exist" from "exists but inaccessible".
 */
function acceptCandidateWithinRoot(p: string, root: string): string | undefined {
  try {
    const stat = lstatSync(p);
    if (stat.isSymbolicLink()) {
      const real = realpathSync(p);
      if (!lstatSync(real).isFile()) return undefined;
      // Reject symlinks whose targets lie outside the permitted subtree.
      if (!isInsideOrEqual(real, root)) return undefined;
      // Return the original symlink path so loadManifestConfig anchors relative
      // references (policyFile, filesystem paths) to the symlink's location rather
      // than the target's — preserving identical semantics to `--manifest ./koi.yaml`.
      // TOCTOU note: the window between this validation and the open() is narrow and
      // requires an attacker to already have write access to the project tree.
      return p;
    }
    if (stat.isFile()) {
      // Resolve the full canonical path to check containment, even for regular files.
      // This guards against a cwd fallback that is non-canonical (symlinked ancestors)
      // while findProjectRoot returned a canonical stopAt — without this check a
      // regular file in a symlinked cwd would bypass containment entirely.
      const real = realpathSync(p);
      if (!isInsideOrEqual(real, root)) return undefined;
      return p;
    }
    return undefined;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code;
    // ENOENT: path does not exist; ENOTDIR: path component is not a dir — both are "not found".
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw e; // EACCES, EPERM, ELOOP, EIO, etc. — surface to caller
  }
}

/**
 * Resolves the manifest path for `koi start` / `koi tui`.
 *
 * - `flagValue` provided → validate file exists; error if missing
 * - `flagValue` undefined → walk up from cwd to git root checking 4 candidates
 * - `noManifest: true` → skip discovery, return undefined
 *
 * Callers decide what to do when path is undefined (error vs. defaults).
 */
export function resolveManifestPath(
  cwd: string,
  flagValue: string | undefined,
  noManifest = false,
): ManifestPathResult {
  if (noManifest) {
    return { ok: true, path: undefined, searched: [], insideProject: false };
  }

  if (flagValue !== undefined) {
    const abs = isAbsolute(flagValue) ? flagValue : resolve(cwd, flagValue);
    let accepted: string | undefined;
    try {
      accepted = acceptRegularFile(abs);
    } catch (e: unknown) {
      const code = (e as NodeJS.ErrnoException).code ?? "UNKNOWN";
      return { ok: false, error: `manifest access error (${code}): ${abs}` };
    }
    if (accepted === undefined) {
      return { ok: false, error: `manifest not found: ${abs}` };
    }
    return { ok: true, path: accepted, searched: [], insideProject: false };
  }

  // Canonicalize cwd so a symlinked working directory still finds the real .git.
  let canonicalCwd: string;
  try {
    canonicalCwd = realpathSync(resolve(cwd));
  } catch {
    canonicalCwd = resolve(cwd);
  }

  // Walk up for either a .git or .koi/ boundary marker. The .koi/ marker
  // lets non-git deployments (tarballs, containers, CI workspaces) define an
  // explicit project root without needing a git repo. Without either marker
  // only cwd is checked — walking to the filesystem root would silently apply
  // a parent-level manifest from an unrelated project (trust-boundary regression).
  let projectRoot: string | undefined;
  try {
    projectRoot = findProjectRoot(canonicalCwd);
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException).code ?? "UNKNOWN";
    return {
      ok: false,
      error: `boundary detection error (${code}): cannot safely determine project root`,
    };
  }
  const searched: string[] = [];
  let current = canonicalCwd;

  // When a project boundary is known, stop at it and enforce symlink containment.
  // When none is found, bound to cwd so an unrelated ancestor koi.yaml in a
  // shared workspace, home dir, or container root is never silently applied.
  // Markerless projects must either run from the project root or use --manifest.
  const stopAt = projectRoot ?? canonicalCwd;

  while (true) {
    for (const candidate of MANIFEST_CANDIDATES) {
      const full = join(current, candidate);
      searched.push(full);
      let accepted: string | undefined;
      try {
        accepted = acceptCandidateWithinRoot(full, stopAt);
      } catch (e: unknown) {
        const code = (e as NodeJS.ErrnoException).code ?? "UNKNOWN";
        return { ok: false, error: `manifest discovery error (${code}): ${full}` };
      }
      if (accepted !== undefined) {
        return { ok: true, path: accepted, searched, insideProject: projectRoot !== undefined };
      }
    }

    if (current === stopAt) break;

    const parent = dirname(current);
    if (parent === current) break; // filesystem root
    current = parent;
  }

  return { ok: true, path: undefined, searched, insideProject: projectRoot !== undefined };
}

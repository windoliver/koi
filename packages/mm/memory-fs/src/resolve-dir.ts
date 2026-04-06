/**
 * Worktree-aware memory directory resolution.
 *
 * Default behaviour: each worktree gets its own `.koi/memory/` beneath
 * its own working tree root. This keeps experimental or untrusted worktree
 * activity from leaking across branches.
 *
 * Shared mode (`shared: true`): resolve to the main worktree's memory
 * directory (via git's `commondir`), with a policy file pinning the mode
 * so that later resolutions from a different worktree cannot silently
 * flip between shared and local and cause split-brain.
 */

import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const MEMORY_DIR_NAME = ".koi/memory";
const POLICY_FILENAME = ".policy.json";

/** Resolution mode. */
export type MemoryDirMode = "local" | "shared";

/** Options controlling `resolveMemoryDir`. */
export interface ResolveMemoryDirOptions {
  /**
   * If true, resolve to the main-worktree's memory directory so all
   * worktrees of the same repo share one store. Default is false
   * (worktree-local).
   */
  readonly shared?: boolean;
}

/** Result of a resolution — surfaces the chosen directory and mode. */
export interface ResolvedMemoryDir {
  readonly dir: string;
  readonly mode: MemoryDirMode;
  /** True when no `.git` was found and `dir` is `{cwd}/.koi/memory/`. */
  readonly detached: boolean;
}

/** Thrown when shared-mode resolution fails (bad commondir, escaped path, etc). */
export class MemoryResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryResolutionError";
  }
}

/**
 * Thrown when a worktree attempts to resolve in a mode that conflicts with
 * a previously pinned `.policy.json`. The caller must reconcile explicitly
 * (e.g. by deleting the policy file) before the store will accept writes.
 */
export class MemoryPolicyMismatch extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryPolicyMismatch";
  }
}

/**
 * Resolve the memory directory for the given working directory.
 *
 * Defaults to worktree-local: returns `{gitRoot}/.koi/memory/` where
 * `gitRoot` is the directory containing `.git` (file or directory).
 *
 * With `shared: true`: walks git's `commondir` to the main-worktree root
 * and returns `{mainRoot}/.koi/memory/`. A `.policy.json` file is pinned
 * on first shared resolution so later worktrees of the same repo cannot
 * silently fall back to local mode.
 *
 * If no `.git` is found, returns `{cwd}/.koi/memory/` in local mode.
 *
 * @throws {MemoryResolutionError} if `shared: true` but commondir cannot
 *   be resolved, or if the resolved shared target escapes the git root.
 * @throws {MemoryPolicyMismatch} if a policy file exists and disagrees
 *   with the requested mode.
 */
export async function resolveMemoryDir(
  cwd: string,
  options?: ResolveMemoryDirOptions,
): Promise<ResolvedMemoryDir> {
  const shared = options?.shared === true;
  const gitRoot = await findGitRoot(cwd);

  if (gitRoot === undefined) {
    return { dir: join(cwd, MEMORY_DIR_NAME), mode: "local", detached: true };
  }

  const gitPath = join(gitRoot, ".git");
  const gitStat = await stat(gitPath);

  if (gitStat.isDirectory()) {
    // Main worktree (or a non-worktree repo): local and shared resolve to
    // the same directory, so there is no split-brain risk to guard
    // against. Skip the policy file entirely — pinning it would
    // gratuitously block alternating-mode callers that target the exact
    // same store.
    const dir = join(gitRoot, MEMORY_DIR_NAME);
    return { dir, mode: shared ? "shared" : "local", detached: false };
  }

  // Linked worktree — `.git` is a file with `gitdir: <path>`. Local and
  // shared now target different directories, so policy pinning at the
  // resolved path prevents silent mode flips across worktrees.
  if (!shared) {
    const dir = join(gitRoot, MEMORY_DIR_NAME);
    await enforcePolicy(dir, "local");
    return { dir, mode: "local", detached: false };
  }

  const mainRoot = await resolveMainWorktreeRoot(gitPath);
  const dir = join(mainRoot, MEMORY_DIR_NAME);
  await enforcePolicy(dir, "shared");
  return { dir, mode: "shared", detached: false };
}

async function findGitRoot(from: string): Promise<string | undefined> {
  // let — walking up the directory tree
  let dir = resolve(from);

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- loop guard
  while (true) {
    try {
      await stat(join(dir, ".git"));
      return dir;
    } catch (e: unknown) {
      // Only continue walking on ENOENT — propagate permission/IO errors
      if (!isEnoent(e)) throw e;
      const parent = dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
}

async function resolveMainWorktreeRoot(gitFilePath: string): Promise<string> {
  const content = await readFile(gitFilePath, "utf-8");
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match?.[1]) {
    throw new MemoryResolutionError(
      `shared mode requested but .git file at ${gitFilePath} has no gitdir: entry`,
    );
  }

  const gitdir = resolve(dirname(gitFilePath), match[1].trim());
  const commondirPath = join(gitdir, "commondir");

  // let — assigned once inside try/catch
  let commondirRaw: string;
  try {
    commondirRaw = (await readFile(commondirPath, "utf-8")).trim();
  } catch (e: unknown) {
    if (isEnoent(e)) {
      throw new MemoryResolutionError(
        `shared mode requested but commondir file is missing at ${commondirPath}`,
      );
    }
    throw e;
  }

  const resolvedCommon = resolve(gitdir, commondirRaw);
  // commondir points at the .git directory of the main worktree; the
  // main-worktree root is that directory's parent.
  const candidate = dirname(resolvedCommon);

  // Canonicalize gitdir and resolvedCommon so the structural check below
  // is immune to symlinks and `../../` traversal padding.
  // let — assigned in try/catch
  let canonicalGitdir: string;
  let canonicalCommonGit: string;
  let canonicalMain: string;
  try {
    canonicalGitdir = await realpath(gitdir);
    canonicalCommonGit = await realpath(resolvedCommon);
    canonicalMain = await realpath(candidate);
  } catch (e: unknown) {
    if (isEnoent(e)) {
      throw new MemoryResolutionError(
        `shared mode: could not canonicalize git paths (gitdir=${gitdir}, commondir=${candidate})`,
      );
    }
    throw e;
  }

  // Structural check #1: the worktree's gitdir must live inside
  // `<commondir>/worktrees/`. Git creates linked-worktree gitdirs there
  // and nowhere else. This rejects a manipulated `.git` file whose
  // `gitdir:` points at an unrelated repository's worktree slot, or at
  // an arbitrary directory that happens to contain a `.git`.
  const expectedWorktreesRoot = join(canonicalCommonGit, "worktrees");
  const relGitdir = relative(expectedWorktreesRoot, canonicalGitdir);
  if (
    relGitdir === "" ||
    relGitdir.startsWith("..") ||
    // Direct subdir only — no nested paths.
    relGitdir.includes(sep)
  ) {
    throw new MemoryResolutionError(
      `shared mode: worktree gitdir ${canonicalGitdir} is not a direct child of ${expectedWorktreesRoot}; ` +
        "the .git file may point at an unrelated or attacker-controlled repository.",
    );
  }

  // Structural check #2: main-worktree root must actually contain the
  // `.git` directory we resolved (the commondir's parent). realpath
  // dereferences symlinks, so this also verifies the path is a real
  // on-disk tree.
  try {
    const mainGit = join(canonicalMain, ".git");
    const mainGitStat = await stat(mainGit);
    // Must be a directory — linked worktree commondir points at main's
    // `.git` directory, never at a `.git` file.
    if (!mainGitStat.isDirectory()) {
      throw new MemoryResolutionError(
        `shared mode: main-worktree ${canonicalMain} has .git as non-directory; cannot be a main repo root.`,
      );
    }
  } catch (e: unknown) {
    if (isEnoent(e)) {
      throw new MemoryResolutionError(
        `shared mode: resolved main-worktree root ${canonicalMain} does not contain .git`,
      );
    }
    throw e;
  }

  return canonicalMain;
}

// ---------------------------------------------------------------------------
// Policy pinning — prevents silent split-brain across worktrees
// ---------------------------------------------------------------------------

interface Policy {
  readonly mode: MemoryDirMode;
}

/**
 * Ensure the memory directory's `.policy.json` (if any) agrees with the
 * requested mode. Creates the file on first resolution. Mismatches are
 * loud: the caller must delete the policy file to change modes.
 */
async function enforcePolicy(dir: string, requested: MemoryDirMode): Promise<void> {
  const policyPath = join(dir, POLICY_FILENAME);
  const existing = await readPolicy(policyPath);

  if (existing !== undefined) {
    if (existing.mode === requested) return;
    throw new MemoryPolicyMismatch(
      `memory-fs: requested mode "${requested}" conflicts with pinned policy "${existing.mode}" at ${policyPath}. ` +
        "Delete the policy file to change modes, or reconcile worktree configurations.",
    );
  }

  await mkdir(dir, { recursive: true });
  const payload: Policy = { mode: requested };
  try {
    await writeFile(policyPath, JSON.stringify(payload, null, 2), {
      encoding: "utf-8",
      flag: "wx",
    });
  } catch (e: unknown) {
    // Raced with another resolver creating the same policy. Re-read and
    // verify consistency.
    if (isEexist(e)) {
      const racedPolicy = await readPolicy(policyPath);
      if (racedPolicy?.mode === requested) return;
      throw new MemoryPolicyMismatch(
        `memory-fs: concurrent resolver pinned policy "${racedPolicy?.mode ?? "unreadable"}" ` +
          `while this resolver requested "${requested}" at ${policyPath}.`,
      );
    }
    throw e;
  }
}

async function readPolicy(path: string): Promise<Policy | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "mode" in parsed &&
      (parsed as { readonly mode: unknown }).mode !== undefined
    ) {
      const mode = (parsed as { readonly mode: unknown }).mode;
      if (mode === "local" || mode === "shared") return { mode };
    }
    return undefined;
  } catch (e: unknown) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
}

/** Check if an error is a filesystem ENOENT (file/dir not found). */
function isEnoent(e: unknown): boolean {
  return hasErrCode(e, "ENOENT");
}

function isEexist(e: unknown): boolean {
  return hasErrCode(e, "EEXIST");
}

function hasErrCode(e: unknown, code: string): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { readonly code: string }).code === code
  );
}

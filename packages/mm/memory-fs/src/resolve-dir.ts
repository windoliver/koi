/**
 * Worktree-aware memory directory resolution.
 *
 * All worktrees of the same repo share a single memory directory
 * at the canonical (main worktree) git root.
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const MEMORY_DIR_NAME = ".koi/memory";

/**
 * Resolve the canonical memory directory for the given working directory.
 *
 * 1. Walk up from `cwd` looking for `.git` (file or directory).
 * 2. If `.git` is a directory (normal repo): return `{root}/.koi/memory/`.
 * 3. If `.git` is a file (worktree): follow `gitdir:` → `commondir` → main root.
 * 4. If no `.git` found: fall back to `{cwd}/.koi/memory/`.
 */
export async function resolveMemoryDir(cwd: string): Promise<string> {
  const gitRoot = await findGitRoot(cwd);
  if (gitRoot === undefined) return join(cwd, MEMORY_DIR_NAME);

  const gitPath = join(gitRoot, ".git");
  const gitStat = await stat(gitPath);

  if (gitStat.isDirectory()) {
    return join(gitRoot, MEMORY_DIR_NAME);
  }

  // Worktree: .git is a file containing `gitdir: <path>`
  const mainRoot = await resolveMainWorktreeRoot(gitPath);
  return mainRoot !== undefined ? join(mainRoot, MEMORY_DIR_NAME) : join(gitRoot, MEMORY_DIR_NAME);
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

async function resolveMainWorktreeRoot(gitFilePath: string): Promise<string | undefined> {
  const content = await readFile(gitFilePath, "utf-8");
  const match = content.match(/^gitdir:\s*(.+)$/m);
  if (!match?.[1]) return undefined;

  const gitdir = resolve(dirname(gitFilePath), match[1].trim());
  const commondirPath = join(gitdir, "commondir");

  try {
    const commondir = (await readFile(commondirPath, "utf-8")).trim();
    const resolvedCommon = resolve(gitdir, commondir);
    // commondir points to the .git directory of the main worktree
    return dirname(resolvedCommon);
  } catch (e: unknown) {
    // No commondir file — not a worktree, fall back to local root
    if (isEnoent(e)) return undefined;
    throw e;
  }
}

/** Check if an error is a filesystem ENOENT (file/dir not found). */
function isEnoent(e: unknown): boolean {
  return (
    typeof e === "object" &&
    e !== null &&
    "code" in e &&
    (e as { readonly code: string }).code === "ENOENT"
  );
}

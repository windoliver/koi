/**
 * @koi/rules-loader — Git root detection.
 *
 * Walks upward from a given directory until a valid .git is found.
 * Accepts .git directories and .git worktree pointer files (gitdir: ...).
 * Inlined to avoid depending on @koi/mm/memory-fs (not L0u).
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Check if a path is a valid git root indicator:
 * - A directory named `.git` (normal repo)
 * - A file named `.git` containing `gitdir:` (worktree)
 * Rejects arbitrary files that happen to be named `.git`.
 */
async function isValidGitMarker(gitPath: string): Promise<boolean> {
  const s = await stat(gitPath);
  if (s.isDirectory()) return true;
  if (s.isFile()) {
    const content = await readFile(gitPath, "utf-8");
    return content.trimStart().startsWith("gitdir:");
  }
  return false;
}

/**
 * Walk from `from` upward to filesystem root.
 * Return the first directory containing a valid `.git`, or `undefined`.
 */
export async function findGitRoot(from: string): Promise<string | undefined> {
  let dir = resolve(from);
  for (;;) {
    try {
      if (await isValidGitMarker(join(dir, ".git"))) {
        return dir;
      }
    } catch (e: unknown) {
      if (!(e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT")) {
        throw e;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * @koi/rules-loader — File discovery.
 *
 * Walk from cwd up to git root (or filesystem root), collecting recognized
 * rules filenames. Returns files ordered root-first (broadest scope first).
 */

import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { DiscoveredFile } from "./config.js";

function isEnoent(e: unknown): boolean {
  return e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT";
}

/**
 * Check whether a file exists and, if it is a symlink, verify its resolved
 * target stays within the allowed boundary. Returns the real path if valid,
 * or `undefined` if the file is missing, not a regular file, or a symlink
 * that escapes the boundary.
 */
async function validateCandidate(
  path: string,
  boundary: string | undefined,
): Promise<string | undefined> {
  try {
    const ls = await lstat(path);
    if (!ls.isFile() && !ls.isSymbolicLink()) return undefined;

    if (ls.isSymbolicLink()) {
      const resolved = await realpath(path);
      // Symlink must resolve within the boundary (git root or cwd)
      if (boundary !== undefined && !resolved.startsWith(`${boundary}/`) && resolved !== boundary) {
        return undefined;
      }
      // Verify the resolved target is a regular file
      const targetStat = await lstat(resolved);
      if (!targetStat.isFile()) return undefined;
    }

    return path;
  } catch (e: unknown) {
    if (isEnoent(e)) return undefined;
    throw e;
  }
}

/**
 * Collect directories from cwd up to stopAt (inclusive).
 * Returns directories ordered from cwd (deepest) to stopAt (shallowest).
 */
function collectDirectories(cwd: string, stopAt: string | undefined): readonly string[] {
  const dirs: string[] = [];
  let dir = resolve(cwd);
  const boundary = stopAt !== undefined ? resolve(stopAt) : undefined;

  for (;;) {
    dirs.push(dir);
    if (boundary !== undefined && dir === boundary) break;
    const parent = dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }

  return dirs;
}

/**
 * Walk from `cwd` up to `gitRoot`, collecting recognized rules filenames
 * at each directory level.
 *
 * When no git root is found, only scans `cwd` itself — prevents ancestor
 * contamination from unrelated directories above the project boundary.
 *
 * Returns files ordered root-first (broadest scope first, depth 0).
 */
export async function discoverRulesFiles(
  cwd: string,
  gitRoot: string | undefined,
  scanPaths: readonly string[],
): Promise<readonly DiscoveredFile[]> {
  // No git root → only scan cwd to prevent cross-project injection
  const dirs = gitRoot !== undefined ? collectDirectories(cwd, gitRoot) : [resolve(cwd)];
  // dirs is cwd-first; we want root-first, so reverse
  const rootFirst = [...dirs].reverse();
  // Boundary for symlink validation: git root or cwd
  const boundary = gitRoot !== undefined ? resolve(gitRoot) : resolve(cwd);

  const discovered: DiscoveredFile[] = [];

  for (let depth = 0; depth < rootFirst.length; depth++) {
    const dir = rootFirst[depth];
    if (dir === undefined) continue;
    for (const scanPath of scanPaths) {
      const candidate = join(dir, scanPath);
      const valid = await validateCandidate(candidate, boundary);
      if (valid !== undefined) {
        discovered.push({ path: candidate, depth });
      }
    }
  }

  return discovered;
}

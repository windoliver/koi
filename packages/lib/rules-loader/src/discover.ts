/**
 * @koi/rules-loader — File discovery.
 *
 * Walk from cwd up to git root (or filesystem root), collecting recognized
 * rules filenames. Returns files ordered root-first (broadest scope first).
 */

import { stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { DiscoveredFile } from "./config.js";

/**
 * Check whether a file exists (follows symlinks).
 * Returns true if the file exists, false on ENOENT, throws on other errors.
 */
async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch (e: unknown) {
    if (e !== null && typeof e === "object" && "code" in e && e.code === "ENOENT") {
      return false;
    }
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
  filenames: readonly string[],
  searchDirs: readonly string[],
): Promise<readonly DiscoveredFile[]> {
  // No git root → only scan cwd to prevent cross-project injection
  const dirs = gitRoot !== undefined ? collectDirectories(cwd, gitRoot) : [resolve(cwd)];
  // dirs is cwd-first; we want root-first, so reverse
  const rootFirst = [...dirs].reverse();

  const discovered: DiscoveredFile[] = [];

  for (let depth = 0; depth < rootFirst.length; depth++) {
    const dir = rootFirst[depth];
    if (dir === undefined) continue;
    for (const searchDir of searchDirs) {
      for (const filename of filenames) {
        const candidate = searchDir === "." ? join(dir, filename) : join(dir, searchDir, filename);
        if (await fileExists(candidate)) {
          discovered.push({ path: candidate, depth });
        }
      }
    }
  }

  return discovered;
}

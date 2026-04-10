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
 * Validate a candidate rules file path. Resolves the canonical path via
 * `realpath()` to catch symlinks at any level (file or parent directory),
 * then verifies the resolved target is a regular file within the allowed
 * boundary.
 */
async function validateCandidate(
  path: string,
  boundary: string | undefined,
): Promise<string | undefined> {
  try {
    // Resolve the canonical path to catch symlinks anywhere in the chain
    const resolved = await realpath(path);

    // Verify the resolved target is within the repo boundary
    if (boundary !== undefined && resolved !== boundary && !resolved.startsWith(`${boundary}/`)) {
      return undefined;
    }

    // Verify the resolved target is a regular file
    const st = await lstat(resolved);
    if (!st.isFile()) return undefined;

    return resolved;
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
  // Resolve the canonical boundary path (handles macOS /var → /private/var etc.)
  const rawBoundary = gitRoot !== undefined ? resolve(gitRoot) : resolve(cwd);
  let boundary: string;
  try {
    boundary = await realpath(rawBoundary);
  } catch {
    boundary = rawBoundary;
  }

  const discovered: DiscoveredFile[] = [];

  for (let depth = 0; depth < rootFirst.length; depth++) {
    const dir = rootFirst[depth];
    if (dir === undefined) continue;
    for (const scanPath of scanPaths) {
      const candidate = join(dir, scanPath);
      const canonicalPath = await validateCandidate(candidate, boundary);
      if (canonicalPath !== undefined) {
        discovered.push({ path: candidate, realPath: canonicalPath, depth });
      }
    }
  }

  return discovered;
}

/**
 * Brick module compiler — writes brick implementations to content-addressed
 * .ts files for dynamic import by the promoted executor.
 *
 * Content-addressed: same implementation → same xxHash32 → same file path →
 * same ESM import (no query-string cache busting needed, no memory leak).
 *
 * Bun runs .ts natively — no transpile/compile step required.
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "@koi/core";
import type { ForgeError } from "./errors.js";
import { resolveError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BrickModulePath {
  /** Absolute path to the content-addressed .ts module file. */
  readonly modulePath: string;
  /** xxHash32 of the implementation source (used as filename). */
  readonly hash: string;
  /** True if the file already existed (cache hit). */
  readonly cached: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_DIR = (() => {
  const xdg = process.env.XDG_CACHE_HOME;
  const home = process.env.HOME ?? "/tmp";
  const base = xdg ?? join(home, ".cache");
  return join(base, "koi", "brick-modules");
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a brick's implementation to a content-addressed .ts file.
 *
 * Uses Bun.hash.xxHash32 for the filename (fast, non-crypto — appropriate
 * for cache keys where collision = stale module, not a security issue).
 * Bun runs .ts natively, so no transpile step is needed.
 *
 * @param implementation - TypeScript source code of the brick
 * @param cacheDir - Directory to write module files (default: $XDG_CACHE_HOME/koi/brick-modules)
 * @returns Result with module path, hash, and cache-hit flag
 */
export async function compileBrickModule(
  implementation: string,
  cacheDir?: string,
): Promise<Result<BrickModulePath, ForgeError>> {
  if (implementation.length === 0) {
    return {
      ok: false,
      error: resolveError(
        "WORKSPACE_FAILED",
        "Cannot compile brick module: implementation is empty",
      ),
    };
  }

  const dir = cacheDir ?? DEFAULT_CACHE_DIR;
  const hash = Bun.hash.xxHash32(implementation).toString(16);
  const modulePath = join(dir, `${hash}.ts`);

  // Fast path: file already exists (content-addressed = idempotent)
  const file = Bun.file(modulePath);
  if (await file.exists()) {
    return {
      ok: true,
      value: { modulePath, hash, cached: true },
    };
  }

  // Ensure cache directory exists
  try {
    await mkdir(dir, { recursive: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: resolveError(
        "WORKSPACE_FAILED",
        `Failed to create brick module cache directory: ${msg}`,
      ),
    };
  }

  // Write the .ts source file
  try {
    await Bun.write(modulePath, implementation);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: resolveError("WORKSPACE_FAILED", `Failed to write brick module file: ${msg}`),
    };
  }

  return {
    ok: true,
    value: { modulePath, hash, cached: false },
  };
}

/**
 * Remove module files whose hashes are not in the active set.
 *
 * Call periodically or on ForgeRuntime.dispose() to free disk space
 * from orphaned brick versions.
 *
 * @param activeHashes - Set of xxHash32 hex strings to keep
 * @param cacheDir - Directory containing module files
 * @returns Number of files removed
 */
export async function cleanupOrphanedModules(
  activeHashes: ReadonlySet<string>,
  cacheDir?: string,
): Promise<number> {
  const dir = cacheDir ?? DEFAULT_CACHE_DIR;

  // let justified: mutable counter for removed files
  let removed = 0;

  try {
    const entries = await readdir(dir);
    for (const entry of entries) {
      // Module files are named <hash>.ts
      if (!entry.endsWith(".ts")) continue;
      const hash = entry.slice(0, -3); // Remove .ts extension
      if (!activeHashes.has(hash)) {
        try {
          await rm(join(dir, entry));
          removed += 1;
        } catch (_: unknown) {
          // Skip files that can't be removed
        }
      }
    }
  } catch (_: unknown) {
    // Directory doesn't exist or can't be read — nothing to clean
  }

  return removed;
}

/**
 * Brick workspace manager — per-dependency workspace creation and caching.
 *
 * Creates isolated workspaces for bricks that declare npm `packages` in their
 * `BrickRequires`. Each workspace is keyed by a SHA-256 hash of the sorted
 * dependency map, enabling deduplication across bricks with identical deps.
 *
 * Workspace location: `$XDG_CACHE_HOME/koi/brick-workspaces/<dep-hash>/`
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Result } from "@koi/core";
import type { DependencyConfig, ForgeError } from "@koi/forge-types";
import { resolveError } from "@koi/forge-types";
import { computeContentHash } from "@koi/hash";
import { auditTransitiveDependencies } from "./dependency-audit.js";
import { verifyInstallIntegrity } from "./verify-install-integrity.js";
import { scanWorkspaceCode } from "./workspace-scan.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceResult {
  readonly workspacePath: string;
  readonly depHash: string;
  readonly cached: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CACHE_DIR = (() => {
  const xdg = process.env.XDG_CACHE_HOME;
  const home = process.env.HOME ?? "/tmp";
  const base = xdg ?? join(home, ".cache");
  return join(base, "koi", "brick-workspaces");
})();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic hash for a dependency map.
 * Sorted JSON entries → SHA-256 via `@koi/hash`.
 */
export function computeDependencyHash(packages: Readonly<Record<string, string>>): string {
  const sorted = Object.entries(packages).sort(([a], [b]) => a.localeCompare(b));
  return computeContentHash(sorted);
}

/**
 * Resolve the workspace path for a given dependency hash.
 */
export function resolveWorkspacePath(depHash: string, cacheDir?: string): string {
  return join(cacheDir ?? DEFAULT_CACHE_DIR, depHash);
}

/** In-flight workspace creations — prevents race conditions for same dep hash. */
const inflightWorkspaces = new Map<string, Promise<Result<WorkspaceResult, ForgeError>>>();

/**
 * Create a brick workspace with installed dependencies.
 * Cache-first: if workspace already exists with valid node_modules, reuse it.
 * Deduplicates concurrent requests for the same dependency set.
 */
export async function createBrickWorkspace(
  packages: Readonly<Record<string, string>>,
  config: DependencyConfig,
  cacheDir?: string,
): Promise<Result<WorkspaceResult, ForgeError>> {
  const depHash = computeDependencyHash(packages);

  // Dedup concurrent requests for same dep hash
  const inflight = inflightWorkspaces.get(depHash);
  if (inflight !== undefined) {
    return inflight;
  }

  const promise = createBrickWorkspaceInner(packages, config, depHash, cacheDir);
  inflightWorkspaces.set(depHash, promise);

  try {
    return await promise;
  } finally {
    inflightWorkspaces.delete(depHash);
  }
}

async function createBrickWorkspaceInner(
  packages: Readonly<Record<string, string>>,
  config: DependencyConfig,
  depHash: string,
  cacheDir?: string,
): Promise<Result<WorkspaceResult, ForgeError>> {
  const workspacePath = resolveWorkspacePath(depHash, cacheDir);

  // Cache hit: check if workspace exists with node_modules.
  // Integrity was verified at creation time — skip re-verification on cache hit.
  try {
    const nmStat = await stat(join(workspacePath, "node_modules"));
    if (nmStat.isDirectory()) {
      return {
        ok: true,
        value: { workspacePath, depHash, cached: true },
      };
    }
  } catch (_: unknown) {
    // Not cached — proceed with creation
  }

  // Create workspace directory
  try {
    await mkdir(workspacePath, { recursive: true });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: resolveError("WORKSPACE_FAILED", `Failed to create workspace directory: ${msg}`),
    };
  }

  // Write package.json with exact dependencies
  const packageJson = JSON.stringify(
    {
      name: `brick-workspace-${depHash.slice(0, 8)}`,
      private: true,
      dependencies: packages,
    },
    null,
    2,
  );

  try {
    await Bun.write(join(workspacePath, "package.json"), packageJson);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: resolveError("WORKSPACE_FAILED", `Failed to write package.json: ${msg}`),
    };
  }

  // Run bun install with timeout.
  // --ignore-scripts blocks postinstall scripts to prevent arbitrary code execution
  // during the resolve stage (before sandbox/trust checks).
  //
  // Strategy: For a fresh workspace there's no lockfile, so we run without --frozen-lockfile
  // first. If a cached lockfile exists (re-install), use --frozen-lockfile to ensure
  // deterministic resolution matching what was previously audited.
  try {
    const hasLockfile = await stat(join(workspacePath, "bun.lock"))
      .then((s) => s.isFile())
      .catch(() => false);

    const installArgs = hasLockfile
      ? ["bun", "install", "--frozen-lockfile", "--ignore-scripts"]
      : ["bun", "install", "--ignore-scripts"];

    const proc = Bun.spawn(installArgs, {
      cwd: workspacePath,
      stdout: "pipe",
      stderr: "pipe",
    });

    const timeoutId = setTimeout(() => {
      proc.kill();
    }, config.installTimeoutMs);

    const exitCode = await proc.exited;
    clearTimeout(timeoutId);

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      return {
        ok: false,
        error: resolveError(
          "INSTALL_FAILED",
          `bun install failed (exit ${String(exitCode)}): ${stderr}`,
        ),
      };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("killed") || msg.includes("timeout")) {
      return {
        ok: false,
        error: resolveError(
          "INSTALL_TIMEOUT",
          `bun install timed out after ${String(config.installTimeoutMs)}ms`,
        ),
      };
    }
    return {
      ok: false,
      error: resolveError("INSTALL_FAILED", `bun install error: ${msg}`),
    };
  }

  // Post-install: audit transitive dependencies against blocklist
  try {
    const lockPath = join(workspacePath, "bun.lock");
    const lockContent = await Bun.file(lockPath).text();
    const transitiveResult = auditTransitiveDependencies(lockContent, config);
    if (!transitiveResult.ok) {
      // Clean up workspace — blocked transitive dep found
      await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
      return transitiveResult;
    }
  } catch (_: unknown) {
    // No lockfile generated (e.g., zero deps resolved) — skip transitive audit
  }

  // Post-install: scan node_modules for dangerous code patterns
  const scanResult = await scanWorkspaceCode(workspacePath, config);
  if (!scanResult.ok) {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    return scanResult;
  }

  // Post-install: verify installed packages match declared deps + lockfile
  const integrityResult = await verifyInstallIntegrity(workspacePath, packages);
  if (!integrityResult.ok) {
    await rm(workspacePath, { recursive: true, force: true }).catch(() => {});
    return integrityResult;
  }

  return {
    ok: true,
    value: { workspacePath, depHash, cached: false },
  };
}

/**
 * Write a brick's implementation as a .ts entry file in the workspace.
 * Returns the absolute path to the entry file.
 */
export async function writeBrickEntry(
  workspacePath: string,
  implementation: string,
  brickName: string,
): Promise<string> {
  const entryPath = join(workspacePath, `${brickName}.ts`);
  await Bun.write(entryPath, implementation);
  return entryPath;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface WorkspaceEntry {
  readonly path: string;
  readonly atimeMs: number;
  readonly sizeBytes: number;
}

/** Compute approximate size of a directory by summing file sizes (non-recursive stat). */
async function computeDirectorySize(dir: string): Promise<number> {
  // let justified: totalSize is accumulated across entries
  let totalSize = 0;
  try {
    // @ts-expect-error — recursive option exists at runtime but not in all @types/node versions
    const entries: readonly string[] = await readdir(dir, { recursive: true });
    for (const entry of entries) {
      try {
        const entryStat = await stat(join(dir, entry));
        if (entryStat.isFile()) {
          totalSize += entryStat.size;
        }
      } catch (_: unknown) {
        // Skip unreadable entries
      }
    }
  } catch (_: unknown) {
    // Empty or inaccessible directory
  }
  return totalSize;
}

/**
 * Evict stale workspaces that haven't been accessed within `maxWorkspaceAgeDays`,
 * then enforce `maxCacheSizeBytes` by evicting LRU workspaces until under budget.
 * Returns the number of evicted workspaces.
 */
export async function cleanupStaleWorkspaces(
  config: DependencyConfig,
  cacheDir?: string,
): Promise<number> {
  const baseDir = cacheDir ?? DEFAULT_CACHE_DIR;
  const maxAgeMs = config.maxWorkspaceAgeDays * 24 * 60 * 60 * 1_000;
  const cutoff = Date.now() - maxAgeMs;

  // let justified: mutable counter for evicted workspaces
  let evicted = 0;

  try {
    const entries = await readdir(baseDir);
    const surviving: WorkspaceEntry[] = [];

    // Phase 1: Age-based eviction
    for (const entry of entries) {
      const entryPath = join(baseDir, entry);
      try {
        const entryStat = await stat(entryPath);
        if (!entryStat.isDirectory()) {
          continue;
        }
        if (entryStat.atimeMs < cutoff) {
          await rm(entryPath, { recursive: true, force: true });
          evicted += 1;
        } else {
          const sizeBytes = await computeDirectorySize(entryPath);
          surviving.push({ path: entryPath, atimeMs: entryStat.atimeMs, sizeBytes });
        }
      } catch (_: unknown) {
        // Skip entries that can't be stat'd
      }
    }

    // Phase 2: Size-based LRU eviction
    // let justified: totalSize is accumulated then decremented during eviction
    let totalSize = surviving.reduce((sum, w) => sum + w.sizeBytes, 0);
    if (totalSize > config.maxCacheSizeBytes) {
      // Sort by access time ascending (oldest first = evict first)
      const sorted = [...surviving].sort((a, b) => a.atimeMs - b.atimeMs);
      for (const ws of sorted) {
        if (totalSize <= config.maxCacheSizeBytes) {
          break;
        }
        try {
          await rm(ws.path, { recursive: true, force: true });
          totalSize -= ws.sizeBytes;
          evicted += 1;
        } catch (_: unknown) {
          // Skip if can't remove
        }
      }
    }
  } catch (_: unknown) {
    // Base directory doesn't exist — nothing to clean
  }

  return evicted;
}

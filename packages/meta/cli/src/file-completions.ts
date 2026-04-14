/**
 * File completion service for @-mention overlay (#10).
 *
 * Uses `git ls-files` for file enumeration (respects .gitignore),
 * falls back to Bun.Glob for non-git dirs, caches results with TTL +
 * git-index-mtime optimization, and applies FileIndex (nucleo-style
 * scorer with bitmap pre-filtering) for fast fuzzy ranking.
 *
 * Design informed by Claude Code's fileSuggestions.ts and OpenCode's
 * file/index.ts.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FileIndex } from "./file-index.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum results returned to the TUI overlay. CC uses 15, OpenCode uses 10. */
const MAX_RESULTS = 15;

/** Cache TTL in milliseconds. Fallback when git-index-mtime is unavailable. */
const CACHE_TTL_MS = 5_000;

/**
 * Debounce delay for file scan (ms). CC uses 50ms (tuned for macOS
 * key-repeat ~33ms). Only applies when cache is cold.
 */
const DEBOUNCE_MS = 50;

/** Directories always excluded from Bun.Glob fallback (non-git repos). */
const EXCLUDED_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".turbo",
  "__pycache__",
  ".next",
  "build",
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Cached file index with expiry and git-index mtime snapshot. */
interface FileCache {
  readonly index: FileIndex;
  readonly expiresAt: number;
  /** .git/index mtime at cache time. Null for non-git dirs. */
  readonly gitIndexMtime: number | null;
}

// ---------------------------------------------------------------------------
// Pure matching function (testable without filesystem)
// ---------------------------------------------------------------------------

/**
 * Filter and rank file paths against a query using the FileIndex scorer.
 *
 * @param query  - Partial file path typed after "@" (e.g., "src/m")
 * @param index  - Pre-built FileIndex
 * @returns Top MAX_RESULTS matches, best-first
 */
export function resolveFileCompletions(query: string, index: FileIndex): readonly string[] {
  const results = index.search(query, MAX_RESULTS);
  return results.map((r) => r.path);
}

/**
 * Overload for testing: accepts raw file list, builds index internally.
 */
export function resolveFileCompletionsFromList(
  query: string,
  files: readonly string[],
): readonly string[] {
  const index = new FileIndex();
  index.loadFromFileList(files);
  return resolveFileCompletions(query, index);
}

// ---------------------------------------------------------------------------
// Git index mtime optimization
// ---------------------------------------------------------------------------

/**
 * Stat .git/index to detect git state changes without spawning git ls-files.
 * Returns null for non-git dirs, worktrees (.git is a file), and errors.
 *
 * Ported from CC's fileSuggestions.ts getGitIndexMtime().
 */
function getGitIndexMtime(cwd: string): number | null {
  try {
    return statSync(join(cwd, ".git", "index")).mtimeMs;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// File enumeration strategies
// ---------------------------------------------------------------------------

/**
 * Enumerate tracked and untracked-but-not-ignored files using `git ls-files`.
 * Returns null on non-git dirs or errors (caller should use fallback).
 */
async function enumerateGitFiles(cwd: string): Promise<readonly string[] | null> {
  try {
    const proc = Bun.spawn(["git", "ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    if (exitCode !== 0) return null;
    return output.split("\n").filter((line) => line.length > 0);
  } catch {
    return null;
  }
}

/**
 * Fallback: enumerate files using Bun.Glob for non-git directories.
 * Excludes common non-source directories via hardcoded list.
 */
async function enumerateGlobFiles(cwd: string): Promise<readonly string[]> {
  const glob = new Bun.Glob("**/*");
  const paths: string[] = [];
  const MAX_SCAN = 50_000;

  try {
    for await (const match of glob.scan({ cwd, onlyFiles: true, followSymlinks: false })) {
      const firstSegment = match.split("/")[0] ?? "";
      if (EXCLUDED_DIRS.includes(firstSegment)) continue;
      paths.push(match);
      if (paths.length >= MAX_SCAN) break;
    }
  } catch {
    // Non-fatal
  }

  return paths;
}

/**
 * Enumerate files + extract directory entries for drill-down.
 */
async function enumerateFiles(cwd: string): Promise<readonly string[]> {
  const gitFiles = await enumerateGitFiles(cwd);
  const files = gitFiles ?? (await enumerateGlobFiles(cwd));

  // Extract unique directory paths (with trailing /) for drill-down
  const dirs = new Set<string>();
  for (const file of files) {
    let dir = file;
    let idx = dir.lastIndexOf("/");
    while (idx > 0) {
      dir = dir.slice(0, idx);
      if (dirs.has(dir)) break;
      dirs.add(dir);
      idx = dir.lastIndexOf("/");
    }
  }

  const dirEntries = [...dirs].map((d) => `${d}/`);
  return [...dirEntries, ...files];
}

/**
 * Get top-level directory listing for empty query (bare "@").
 */
function getTopLevelPaths(cwd: string): readonly string[] {
  try {
    const entries = readdirSync(cwd, { withFileTypes: true });
    return entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .slice(0, MAX_RESULTS);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Cached completion handler (stateful, one instance per TUI session)
// ---------------------------------------------------------------------------

/**
 * Create a file completion handler with built-in cache, debounce,
 * and git-index-mtime optimization.
 *
 * @param cwd      - Working directory for git ls-files
 * @param dispatch - Store dispatch function for set_at_results
 */
export function createFileCompletionHandler(
  cwd: string,
  dispatch: (results: readonly string[]) => void,
): (query: string | null) => void {
  // `let` justified: mutable cache state, replaced on each refresh
  let cache: FileCache | null = null;
  // `let` justified: debounce timer ID, cleared/reset on each query
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  // `let` justified: shared in-flight scan promise (avoids duplicate concurrent scans)
  let scanPromise: Promise<FileIndex> | null = null;
  // `let` justified: monotonic request counter — async results are dropped if
  // a newer query was issued while the scan was in flight (prevents stale dispatch)
  let requestGeneration = 0;

  /**
   * Check if cache is still valid. Two paths:
   * 1. git-index-mtime: if .git/index hasn't changed, files haven't changed
   * 2. TTL fallback: for non-git dirs or when mtime is unavailable
   */
  const isCacheValid = (): boolean => {
    if (cache === null) return false;
    const now = Date.now();

    // If we have a git mtime snapshot, check if it changed
    if (cache.gitIndexMtime !== null) {
      const currentMtime = getGitIndexMtime(cwd);
      if (currentMtime !== null && currentMtime === cache.gitIndexMtime) {
        return true; // Git index unchanged — cache is authoritative
      }
      // Mtime changed or unavailable — fall through to TTL
    }

    return now < cache.expiresAt;
  };

  const buildIndex = async (): Promise<FileIndex> => {
    if (isCacheValid() && cache !== null) {
      return cache.index;
    }

    // Share in-flight scan promise so concurrent callers await the same result
    if (scanPromise !== null) {
      return scanPromise;
    }

    scanPromise = (async (): Promise<FileIndex> => {
      // Snapshot git-index mtime BEFORE the scan so we can detect if
      // the index changed mid-scan. If it did, the cached mtime would
      // be newer than the file list — causing isCacheValid() to treat
      // a stale list as authoritative. Using pre-scan mtime avoids this.
      const preScanMtime = getGitIndexMtime(cwd);
      const files = await enumerateFiles(cwd);
      const postScanMtime = getGitIndexMtime(cwd);

      const index = new FileIndex();
      index.loadFromFileList(files);

      // Only cache with mtime if it didn't change during the scan.
      // If it changed, fall through to TTL-based expiry instead.
      const stableMtime = preScanMtime === postScanMtime ? preScanMtime : null;
      cache = {
        index,
        expiresAt: Date.now() + CACHE_TTL_MS,
        gitIndexMtime: stableMtime,
      };
      return index;
    })();

    try {
      return await scanPromise;
    } finally {
      scanPromise = null;
    }
  };

  return (query: string | null): void => {
    // Bump generation on every query — stale async results are discarded
    const thisGeneration = ++requestGeneration;

    // Clear any pending debounce
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    // Null query = overlay dismissed
    if (query === null) {
      dispatch([]);
      return;
    }

    // Empty query (bare "@"): show top-level cwd listing immediately
    if (query === "") {
      dispatch(getTopLevelPaths(cwd));
      return;
    }

    // If cache is valid, resolve immediately (no debounce needed)
    if (isCacheValid() && cache !== null) {
      const results = resolveFileCompletions(query, cache.index);
      dispatch(results);
      return;
    }

    // Cache cold — debounce the initial scan
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void (async (): Promise<void> => {
        const index = await buildIndex();
        // Drop stale results if a newer query was issued during the scan
        if (requestGeneration !== thisGeneration) return;
        const results = resolveFileCompletions(query, index);
        dispatch(results);
      })();
    }, DEBOUNCE_MS);
  };
}

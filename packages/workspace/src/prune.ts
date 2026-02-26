/**
 * Stale workspace pruning utility.
 *
 * Detects and cleans up orphaned git worktrees by inspecting
 * .koi-workspace marker files for dead PIDs and expired age.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import type { KoiError } from "@koi/core";
import { runGit } from "@koi/git-utils";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Options for pruning stale workspaces. */
export interface PruneOptions {
  readonly maxAgeMs?: number;
  readonly dryRun?: boolean;
}

/** Result of a prune operation. */
export interface PruneResult {
  readonly pruned: readonly string[];
  readonly errors: readonly KoiError[];
}

interface MarkerData {
  readonly id: string;
  readonly agentId: string;
  readonly createdAt: number;
  readonly pid: number;
  readonly branchName: string;
}

const MARKER_FILENAME = ".koi-workspace";
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000; // 24 hours

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Prune stale koi workspaces from a git repository.
 *
 * Scans all worktrees for .koi-workspace markers, checks if the
 * owning process is still alive and whether the workspace has exceeded
 * maxAgeMs. Removes stale entries unless dryRun is true.
 *
 * Side-effect: spawns git processes, removes worktrees.
 */
export async function pruneStaleWorkspaces(
  repoPath: string,
  options?: PruneOptions,
): Promise<PruneResult> {
  const maxAgeMs = options?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const dryRun = options?.dryRun ?? false;

  const listResult = await runGit(["worktree", "list", "--porcelain"], repoPath);
  if (!listResult.ok) {
    return { pruned: [], errors: [listResult.error] };
  }

  const worktreePaths = parseWorktreeList(listResult.value);
  const pruned: string[] = [];
  const errors: KoiError[] = [];

  for (const wtPath of worktreePaths) {
    const markerPath = `${wtPath}/${MARKER_FILENAME}`;
    if (!existsSync(markerPath)) continue;

    const marker = await readMarker(markerPath);
    if (!marker) continue;

    const isStale = isProcessDead(marker.pid) || Date.now() - marker.createdAt > maxAgeMs;
    if (!isStale) continue;

    if (dryRun) {
      pruned.push(wtPath);
      continue;
    }

    const removeResult = await runGit(["worktree", "remove", "--force", wtPath], repoPath);

    if (removeResult.ok) {
      pruned.push(wtPath);
    } else {
      errors.push(removeResult.error);
    }
  }

  // Safety net: run git worktree prune to clean up stale admin files
  if (!dryRun) {
    await runGit(["worktree", "prune"], repoPath);
  }

  return { pruned, errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseWorktreeList(porcelain: string): readonly string[] {
  return porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
    .slice(1); // skip main working tree
}

function isValidMarker(value: unknown): value is MarkerData {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.agentId === "string" &&
    typeof obj.createdAt === "number" &&
    typeof obj.pid === "number" &&
    typeof obj.branchName === "string"
  );
}

async function readMarker(path: string): Promise<MarkerData | undefined> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidMarker(parsed)) return undefined;
    return parsed;
  } catch (e: unknown) {
    console.warn(
      `[workspace] Failed to read marker at ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
    return undefined;
  }
}

function isProcessDead(pid: number): boolean {
  try {
    // signal 0 tests if process exists without sending a signal
    process.kill(pid, 0);
    return false;
  } catch (e: unknown) {
    // EPERM = process exists but we lack permission → still alive
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "EPERM") {
      return false;
    }
    // ESRCH or other errors → process is dead
    return true;
  }
}

/**
 * Git diff utilities — changed file detection for drift scoring.
 *
 * Wraps `runGit` to extract lists of changed files and HEAD commit hashes.
 */

import type { KoiError, Result } from "@koi/core";
import { runGit } from "./run-git.js";

/**
 * List files changed since a given commit.
 *
 * Uses `git diff --name-only <commit>` to detect changed files.
 * Side-effect: spawns a child process.
 *
 * @param commit - Base commit hash to diff against.
 * @param cwd - Working directory for the git command.
 * @returns List of changed file paths relative to the repo root.
 */
export async function changedFilesSince(
  commit: string,
  cwd: string,
): Promise<Result<readonly string[], KoiError>> {
  const result = await runGit(["diff", "--name-only", commit], cwd);
  if (!result.ok) return result;
  const files = result.value.split("\n").filter((line) => line.length > 0);
  return { ok: true, value: files };
}

/**
 * Get the current HEAD commit hash.
 *
 * Uses `git rev-parse HEAD` to retrieve the full SHA.
 * Side-effect: spawns a child process.
 *
 * @param cwd - Working directory for the git command.
 * @returns The full 40-character commit hash.
 */
export async function getHeadCommit(cwd: string): Promise<Result<string, KoiError>> {
  return runGit(["rev-parse", "HEAD"], cwd);
}

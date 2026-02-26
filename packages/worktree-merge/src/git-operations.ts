/**
 * Typed wrappers around runGit for merge-specific git operations.
 */

import type { KoiError, Result } from "@koi/core";
import { runGit } from "@koi/git-utils";

/** Merge a branch with --no-ff (creates a merge commit). */
export async function gitMergeNoFf(branch: string, cwd: string): Promise<Result<string, KoiError>> {
  const result = await runGit(["merge", "--no-ff", branch, "-m", `Merge branch '${branch}'`], cwd);
  if (!result.ok) return result;
  return gitRevParseHead(cwd);
}

/** Octopus merge: merge multiple branches at once. */
export async function gitMergeOctopus(
  branches: readonly string[],
  cwd: string,
): Promise<Result<string, KoiError>> {
  const result = await runGit(
    ["merge", ...branches, "-m", `Octopus merge: ${branches.join(", ")}`],
    cwd,
  );
  if (!result.ok) return result;
  return gitRevParseHead(cwd);
}

/** Rebase a branch onto target, then fast-forward merge. */
export async function gitRebase(
  onto: string,
  branch: string,
  cwd: string,
): Promise<Result<string, KoiError>> {
  const rebaseResult = await runGit(["rebase", onto, branch], cwd);
  if (!rebaseResult.ok) return rebaseResult;
  // Switch to the target branch and fast-forward
  const checkoutResult = await runGit(["checkout", onto], cwd);
  if (!checkoutResult.ok) return checkoutResult;
  const ffResult = await runGit(["merge", "--ff-only", branch], cwd);
  if (!ffResult.ok) return ffResult;
  return gitRevParseHead(cwd);
}

/** Hard reset to a ref. Side-effect: destroys uncommitted changes. */
export async function gitResetHard(ref: string, cwd: string): Promise<Result<void, KoiError>> {
  const result = await runGit(["reset", "--hard", ref], cwd);
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

/** Get the current HEAD commit SHA. */
export async function gitRevParseHead(cwd: string): Promise<Result<string, KoiError>> {
  return runGit(["rev-parse", "HEAD"], cwd);
}

/** Abort an in-progress merge. */
export async function gitMergeAbort(cwd: string): Promise<Result<void, KoiError>> {
  const result = await runGit(["merge", "--abort"], cwd);
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

/** Abort an in-progress rebase. */
export async function gitRebaseAbort(cwd: string): Promise<Result<void, KoiError>> {
  const result = await runGit(["rebase", "--abort"], cwd);
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

/** List files with merge conflicts. */
export async function gitDiffConflictFiles(
  cwd: string,
): Promise<Result<readonly string[], KoiError>> {
  const result = await runGit(["diff", "--name-only", "--diff-filter=U"], cwd);
  if (!result.ok) return result;
  const files = result.value.split("\n").filter((f) => f.length > 0);
  return { ok: true, value: files };
}

/** Resolve a local branch name to its tip SHA. */
export async function gitRevParseBranch(
  branch: string,
  cwd: string,
): Promise<Result<string, KoiError>> {
  return runGit(["rev-parse", `refs/heads/${branch}`], cwd);
}

/** Check if a branch exists locally. */
export async function gitBranchExists(
  branch: string,
  cwd: string,
): Promise<Result<boolean, KoiError>> {
  const result = await runGit(["rev-parse", "--verify", `refs/heads/${branch}`], cwd);
  if (result.ok) return { ok: true, value: true };
  if (result.error.code === "EXTERNAL") {
    return { ok: true, value: false };
  }
  return result;
}

/** Ensure we're on the specified branch. */
export async function gitCheckout(branch: string, cwd: string): Promise<Result<void, KoiError>> {
  const result = await runGit(["checkout", branch], cwd);
  if (!result.ok) return result;
  return { ok: true, value: undefined };
}

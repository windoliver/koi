/**
 * Octopus merge strategy: merge multiple branches at once.
 *
 * Only works for conflict-free branches at the same level. On conflict,
 * falls back to sequential merging of individual branches.
 */

import { gitMergeOctopus, gitResetHard, gitRevParseHead } from "./git-operations.js";
import { mergeSequential } from "./merge-sequential.js";
import type { BranchMergeOutcome, ConflictResolverFn } from "./types.js";

/** Merge a single branch via octopus (delegates to git merge). */
export async function mergeOctopus(
  branch: string,
  targetBranch: string,
  repoPath: string,
  resolveConflict: ConflictResolverFn,
): Promise<BranchMergeOutcome> {
  // Single-branch octopus is just a regular merge
  return mergeSequential(branch, targetBranch, repoPath, resolveConflict);
}

/**
 * Attempt an octopus merge of all branches in a level.
 *
 * Returns outcomes per branch. If octopus fails, resets and
 * falls back to sequential merging.
 */
export async function mergeOctopusLevel(
  branches: readonly string[],
  targetBranch: string,
  repoPath: string,
  resolveConflict: ConflictResolverFn,
): Promise<ReadonlyMap<string, BranchMergeOutcome>> {
  if (branches.length === 0) {
    return new Map();
  }

  if (branches.length === 1) {
    // Safe: length check above guarantees index 0 exists
    const name = branches[0] as string;
    const outcome = await mergeSequential(name, targetBranch, repoPath, resolveConflict);
    return new Map([[name, outcome]]);
  }

  // Capture restore point for rollback
  const headResult = await gitRevParseHead(repoPath);
  if (!headResult.ok) {
    const outcomes = new Map<string, BranchMergeOutcome>();
    for (const branch of branches) {
      outcomes.set(branch, { kind: "failed", error: headResult.error });
    }
    return outcomes;
  }
  const restoreRef = headResult.value;

  // Try octopus merge
  const octopusResult = await gitMergeOctopus(branches, repoPath);
  if (octopusResult.ok) {
    const outcomes = new Map<string, BranchMergeOutcome>();
    for (const branch of branches) {
      outcomes.set(branch, { kind: "merged", commitSha: octopusResult.value });
    }
    return outcomes;
  }

  // Octopus failed — reset and fall back to sequential
  await gitResetHard(restoreRef, repoPath);

  const outcomes = new Map<string, BranchMergeOutcome>();
  for (const branch of branches) {
    const outcome = await mergeSequential(branch, targetBranch, repoPath, resolveConflict);
    outcomes.set(branch, outcome);
  }
  return outcomes;
}

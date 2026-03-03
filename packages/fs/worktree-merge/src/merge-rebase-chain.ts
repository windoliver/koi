/**
 * Rebase-chain merge strategy: rebase each branch onto target, then ff merge.
 *
 * Rewrites history (documented as explicit tradeoff). On conflict during
 * replay, calls the conflict resolver. If resolution fails, aborts rebase.
 */

import {
  gitCheckout,
  gitDiffConflictFiles,
  gitRebase,
  gitRebaseAbort,
  gitRevParseHead,
} from "./git-operations.js";
import type { BranchMergeOutcome, ConflictResolverFn } from "./types.js";

/** Rebase a branch onto target, then fast-forward merge. */
export async function mergeRebaseChain(
  branch: string,
  targetBranch: string,
  repoPath: string,
  resolveConflict: ConflictResolverFn,
): Promise<BranchMergeOutcome> {
  // Ensure we're on the target branch first
  const checkoutResult = await gitCheckout(targetBranch, repoPath);
  if (!checkoutResult.ok) {
    return { kind: "failed", error: checkoutResult.error };
  }

  const rebaseResult = await gitRebase(targetBranch, branch, repoPath);

  if (rebaseResult.ok) {
    return { kind: "merged", commitSha: rebaseResult.value };
  }

  // Check if this is a rebase conflict
  const conflictFilesResult = await gitDiffConflictFiles(repoPath);
  if (!conflictFilesResult.ok || conflictFilesResult.value.length === 0) {
    // Not a conflict — abort rebase and return failure
    await gitRebaseAbort(repoPath);
    // Switch back to target
    await gitCheckout(targetBranch, repoPath);
    return { kind: "failed", error: rebaseResult.error };
  }

  const conflictFiles = conflictFilesResult.value;
  const headResult = await gitRevParseHead(repoPath);
  const targetRef = headResult.ok ? headResult.value : "unknown";

  const resolution = await resolveConflict({
    branch,
    conflictFiles,
    targetRef,
    branchRef: branch,
  });

  if (resolution.kind === "resolved") {
    return {
      kind: "conflict",
      conflictFiles,
      resolved: true,
    };
  }

  // Resolution was aborted — revert rebase
  await gitRebaseAbort(repoPath);
  await gitCheckout(targetBranch, repoPath);
  return {
    kind: "conflict",
    conflictFiles,
    resolved: false,
  };
}

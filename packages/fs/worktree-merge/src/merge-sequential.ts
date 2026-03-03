/**
 * Sequential merge strategy: git merge --no-ff for each branch.
 *
 * On conflict: calls the conflict resolver. If resolution fails or
 * is aborted, reverts the merge attempt.
 */

import {
  gitDiffConflictFiles,
  gitMergeAbort,
  gitMergeNoFf,
  gitRevParseHead,
} from "./git-operations.js";
import type { BranchMergeOutcome, ConflictResolverFn } from "./types.js";

/** Merge a single branch using --no-ff. */
export async function mergeSequential(
  branch: string,
  _targetBranch: string,
  repoPath: string,
  resolveConflict: ConflictResolverFn,
): Promise<BranchMergeOutcome> {
  const mergeResult = await gitMergeNoFf(branch, repoPath);

  if (mergeResult.ok) {
    return { kind: "merged", commitSha: mergeResult.value };
  }

  // Check if this is a merge conflict (not a different error)
  const conflictFilesResult = await gitDiffConflictFiles(repoPath);
  if (!conflictFilesResult.ok || conflictFilesResult.value.length === 0) {
    // Not a conflict — abort merge state and return failure
    await gitMergeAbort(repoPath);
    return { kind: "failed", error: mergeResult.error };
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

  // Resolution was aborted — revert merge
  await gitMergeAbort(repoPath);
  return {
    kind: "conflict",
    conflictFiles,
    resolved: false,
  };
}

/**
 * @koi/worktree-merge — Branch reconciliation for parallel worktree-based agent work.
 *
 * Provides topological ordering, strategy-based merging, pluggable conflict
 * resolution, configurable verification gates, and structured result reporting.
 */

export { executeMerge } from "./execute-merge.js";
export { mergeOctopus, mergeOctopusLevel } from "./merge-octopus.js";
export { computeMergeLevels, computeMergeOrder } from "./merge-order.js";
export { mergeRebaseChain } from "./merge-rebase-chain.js";
export { mergeSequential } from "./merge-sequential.js";
export type {
  BranchMergeOutcome,
  ConflictInfo,
  ConflictResolution,
  ConflictResolverFn,
  MergeBranch,
  MergeConfig,
  MergeEvent,
  MergeResult,
  MergeStrategyFn,
  MergeStrategyKind,
  VerifyAfter,
  VerifyFn,
  VerifyResult,
} from "./types.js";
export { validateMergeConfig } from "./types.js";

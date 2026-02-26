/**
 * Types for branch reconciliation after parallel worktree-based agent work.
 */

import type { KoiError, Result } from "@koi/core";

// --- Input types ---

/** A branch to merge, with optional ordering dependencies. */
export interface MergeBranch {
  readonly name: string;
  readonly dependsOn: readonly string[];
  /** If set, merge is skipped when branch tip differs (stale-branch guard). */
  readonly expectedRef?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Merge strategy discriminant. */
export type MergeStrategyKind = "sequential" | "octopus" | "rebase-chain";

/** When to run the verify function. */
export type VerifyAfter = "each" | "all" | "levels";

/** Information about a merge conflict, passed to the resolver callback. */
export interface ConflictInfo {
  readonly branch: string;
  readonly conflictFiles: readonly string[];
  readonly targetRef: string;
  readonly branchRef: string;
}

/** Resolution returned by the conflict resolver. */
export type ConflictResolution =
  | { readonly kind: "resolved"; readonly commitSha: string }
  | { readonly kind: "abort" };

/** Pluggable conflict resolution callback. */
export type ConflictResolverFn = (conflict: ConflictInfo) => Promise<ConflictResolution>;

/** Verification callback invoked after merges. */
export type VerifyFn = (
  mergedRef: string,
  mergedBranches: readonly string[],
) => Promise<VerifyResult>;

/** Result of a verification step. */
export interface VerifyResult {
  readonly passed: boolean;
  readonly message?: string;
}

// --- Config ---

/** Full configuration for executeMerge(). */
export interface MergeConfig {
  readonly repoPath: string;
  readonly targetBranch: string;
  readonly branches: readonly MergeBranch[];
  readonly strategy: MergeStrategyKind;
  readonly verifyAfter?: VerifyAfter;
  readonly verify?: VerifyFn;
  readonly resolveConflict?: ConflictResolverFn;
  readonly signal?: AbortSignal;
  readonly onEvent?: (event: MergeEvent) => void;
}

// --- Events (progress notifications, not event-sourced) ---

/** Discriminated union of all merge progress events. */
export type MergeEvent =
  | {
      readonly kind: "merge:started";
      readonly branch: string;
      readonly index: number;
      readonly total: number;
    }
  | {
      readonly kind: "merge:completed";
      readonly branch: string;
      readonly commitSha: string;
    }
  | {
      readonly kind: "merge:conflict";
      readonly branch: string;
      readonly files: readonly string[];
    }
  | {
      readonly kind: "merge:skipped";
      readonly branch: string;
      readonly reason: string;
    }
  | {
      readonly kind: "merge:reverted";
      readonly branch: string;
      readonly reason: string;
    }
  | {
      readonly kind: "merge:failed";
      readonly branch: string;
      readonly error: KoiError;
    }
  | { readonly kind: "verify:started"; readonly branches: readonly string[] }
  | { readonly kind: "verify:passed" }
  | { readonly kind: "verify:failed"; readonly message: string }
  | {
      readonly kind: "level:started";
      readonly level: number;
      readonly branches: readonly string[];
    }
  | { readonly kind: "level:completed"; readonly level: number }
  | { readonly kind: "aborted"; readonly restoreRef: string };

// --- Output types ---

/** Per-branch outcome after a merge attempt. */
export type BranchMergeOutcome =
  | { readonly kind: "merged"; readonly commitSha: string }
  | {
      readonly kind: "conflict";
      readonly conflictFiles: readonly string[];
      readonly resolved: boolean;
    }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "failed"; readonly error: KoiError }
  | { readonly kind: "reverted"; readonly reason: string };

/** Aggregate result of executeMerge(). */
export interface MergeResult {
  readonly strategy: MergeStrategyKind;
  readonly targetBranch: string;
  readonly mergeOrder: readonly string[];
  readonly outcomes: ReadonlyMap<string, BranchMergeOutcome>;
  readonly verified: boolean;
  readonly durationMs: number;
  readonly aborted: boolean;
}

/** Signature shared by all strategy functions. */
export type MergeStrategyFn = (
  branch: string,
  targetBranch: string,
  repoPath: string,
  resolveConflict: ConflictResolverFn,
) => Promise<BranchMergeOutcome>;

// --- Config validation ---

/** Validate MergeConfig, returning an error for invalid inputs. */
export function validateMergeConfig(config: MergeConfig): Result<void, KoiError> {
  if (config.branches.length === 0) {
    return { ok: true, value: undefined };
  }

  if (!config.repoPath) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "repoPath is required",
        retryable: false,
      },
    };
  }

  if (!config.targetBranch) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "targetBranch is required",
        retryable: false,
      },
    };
  }

  const branchNames = new Set(config.branches.map((b) => b.name));
  for (const branch of config.branches) {
    for (const dep of branch.dependsOn) {
      if (!branchNames.has(dep)) {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message: `Branch "${branch.name}" depends on unknown branch "${dep}"`,
            retryable: false,
            context: { branch: branch.name, dependency: dep },
          },
        };
      }
    }
  }

  return { ok: true, value: undefined };
}

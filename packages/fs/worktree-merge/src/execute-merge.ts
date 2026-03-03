/**
 * Main entry point for branch reconciliation.
 *
 * Orchestrates topological ordering, strategy dispatch, verification,
 * and abort handling into a single executeMerge() call.
 */

import type { KoiError, Result } from "@koi/core";
import { gitCheckout, gitResetHard, gitRevParseBranch, gitRevParseHead } from "./git-operations.js";
import { mergeOctopusLevel } from "./merge-octopus.js";
import { computeMergeLevels } from "./merge-order.js";
import { mergeRebaseChain } from "./merge-rebase-chain.js";
import { mergeSequential } from "./merge-sequential.js";
import type {
  BranchMergeOutcome,
  ConflictResolverFn,
  MergeBranch,
  MergeConfig,
  MergeEvent,
  MergeResult,
  MergeStrategyFn,
} from "./types.js";
import { validateMergeConfig } from "./types.js";

/** Default conflict resolver: always aborts (fail-fast). */
const DEFAULT_CONFLICT_RESOLVER: ConflictResolverFn = async () => ({
  kind: "abort" as const,
});

/** Execute a merge plan according to the given configuration. */
export async function executeMerge(config: MergeConfig): Promise<Result<MergeResult, KoiError>> {
  const startTime = performance.now();
  const emit = config.onEvent ?? (() => {});
  const resolveConflict = config.resolveConflict ?? DEFAULT_CONFLICT_RESOLVER;
  const verifyAfter = config.verifyAfter ?? "levels";

  // 1. Validate config
  const validation = validateMergeConfig(config);
  if (!validation.ok) return validation;

  // 2. Handle zero-branch case
  if (config.branches.length === 0) {
    return {
      ok: true,
      value: {
        strategy: config.strategy,
        targetBranch: config.targetBranch,
        mergeOrder: [],
        outcomes: new Map(),
        verified: true,
        durationMs: performance.now() - startTime,
        aborted: false,
      },
    };
  }

  // 3. Compute merge levels
  const levelsResult = computeMergeLevels(config.branches);
  if (!levelsResult.ok) return levelsResult;
  const levels = levelsResult.value;

  // Flat ordered list for result
  const mergeOrder = levels.flat();
  const total = mergeOrder.length;

  // Lookup map for expectedRef checks
  const branchByName = new Map(config.branches.map((b) => [b.name, b]));

  // 4. Capture restore point
  const headResult = await gitRevParseHead(config.repoPath);
  if (!headResult.ok) return headResult;
  const restoreRef = headResult.value;

  // Ensure we're on the target branch
  const checkoutResult = await gitCheckout(config.targetBranch, config.repoPath);
  if (!checkoutResult.ok) return checkoutResult;

  // 5. Track abort state
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
  };
  config.signal?.addEventListener("abort", onAbort, { once: true });

  // 6. Process levels
  const outcomes = new Map<string, BranchMergeOutcome>();
  let globalIndex = 0;
  let verified = false;
  const mergedBranches: string[] = [];

  try {
    for (let levelIdx = 0; levelIdx < levels.length; levelIdx++) {
      // Safe: loop guard ensures index is in bounds
      const level = levels[levelIdx] as readonly string[];

      if (aborted) break;

      emit({
        kind: "level:started",
        level: levelIdx,
        branches: level,
      });

      if (config.strategy === "octopus") {
        // Stale-branch guard: check each branch before octopus merge
        const freshBranches: string[] = [];
        for (const branch of level) {
          const branchDef = branchByName.get(branch);
          const staleOutcome = branchDef
            ? await checkStaleBranch(branchDef, config.repoPath)
            : undefined;
          if (staleOutcome) {
            outcomes.set(branch, staleOutcome);
            emitOutcome(emit, branch, staleOutcome);
          } else {
            freshBranches.push(branch);
          }
        }

        // Octopus: try batch merge per level (only fresh branches)
        const levelOutcomes = await mergeOctopusLevel(
          freshBranches,
          config.targetBranch,
          config.repoPath,
          resolveConflict,
        );
        for (const branch of level) {
          if (aborted) break;
          // Skip branches already handled by staleness check
          if (outcomes.has(branch)) {
            globalIndex++;
            continue;
          }
          const outcome = levelOutcomes.get(branch);
          if (outcome) {
            emit({
              kind: "merge:started",
              branch,
              index: globalIndex,
              total,
            });
            emitOutcome(emit, branch, outcome);
            outcomes.set(branch, outcome);
            if (outcome.kind === "merged" || (outcome.kind === "conflict" && outcome.resolved)) {
              mergedBranches.push(branch);
            }
          }
          globalIndex++;
        }
      } else {
        // Sequential or rebase-chain: process branches one by one
        const strategyFn = selectStrategy(config.strategy);

        for (const branch of level) {
          if (aborted) break;

          emit({
            kind: "merge:started",
            branch,
            index: globalIndex,
            total,
          });

          // Stale-branch guard: skip if expectedRef doesn't match
          const branchDef = branchByName.get(branch);
          const staleOutcome = branchDef
            ? await checkStaleBranch(branchDef, config.repoPath)
            : undefined;

          const outcome =
            staleOutcome ??
            (await strategyFn(branch, config.targetBranch, config.repoPath, resolveConflict));

          emitOutcome(emit, branch, outcome);
          outcomes.set(branch, outcome);
          if (outcome.kind === "merged" || (outcome.kind === "conflict" && outcome.resolved)) {
            mergedBranches.push(branch);
          }
          globalIndex++;

          // Verify after each branch if configured
          if (verifyAfter === "each" && config.verify && !aborted) {
            const verifyResult = await runVerify(config, mergedBranches, emit);
            if (!verifyResult.passed) {
              // Revert to restore point
              await gitResetHard(restoreRef, config.repoPath);
              return {
                ok: true,
                value: {
                  strategy: config.strategy,
                  targetBranch: config.targetBranch,
                  mergeOrder,
                  outcomes,
                  verified: false,
                  durationMs: performance.now() - startTime,
                  aborted: false,
                },
              };
            }
          }
        }
      }

      if (!aborted) {
        emit({ kind: "level:completed", level: levelIdx });
      }

      // Verify after each level if configured
      if (verifyAfter === "levels" && config.verify && !aborted) {
        const verifyResult = await runVerify(config, mergedBranches, emit);
        if (!verifyResult.passed) {
          await gitResetHard(restoreRef, config.repoPath);
          return {
            ok: true,
            value: {
              strategy: config.strategy,
              targetBranch: config.targetBranch,
              mergeOrder,
              outcomes,
              verified: false,
              durationMs: performance.now() - startTime,
              aborted: false,
            },
          };
        }
      }
    }

    // 7. Handle abort
    if (aborted) {
      await gitResetHard(restoreRef, config.repoPath);
      emit({ kind: "aborted", restoreRef });
      return {
        ok: true,
        value: {
          strategy: config.strategy,
          targetBranch: config.targetBranch,
          mergeOrder,
          outcomes,
          verified: false,
          durationMs: performance.now() - startTime,
          aborted: true,
        },
      };
    }

    // 8. Final verify if configured
    if (verifyAfter === "all" && config.verify) {
      const verifyResult = await runVerify(config, mergedBranches, emit);
      verified = verifyResult.passed;
      if (!verified) {
        await gitResetHard(restoreRef, config.repoPath);
      }
    } else if (config.verify) {
      // Already verified per-level or per-each
      verified = true;
    } else {
      // No verify function — mark as verified
      verified = true;
    }

    return {
      ok: true,
      value: {
        strategy: config.strategy,
        targetBranch: config.targetBranch,
        mergeOrder,
        outcomes,
        verified,
        durationMs: performance.now() - startTime,
        aborted: false,
      },
    };
  } catch (e: unknown) {
    // Unexpected failure — restore and report
    await gitResetHard(restoreRef, config.repoPath);
    return {
      ok: false,
      error: {
        code: "INTERNAL",
        message: `executeMerge failed: ${e instanceof Error ? e.message : String(e)}`,
        retryable: false,
        cause: e,
      },
    };
  } finally {
    config.signal?.removeEventListener("abort", onAbort);
  }
}

/** Select the strategy function based on kind. */
function selectStrategy(kind: "sequential" | "rebase-chain"): MergeStrategyFn {
  switch (kind) {
    case "sequential":
      return mergeSequential;
    case "rebase-chain":
      return mergeRebaseChain;
  }
}

/** Run the verify function and emit events. */
async function runVerify(
  config: MergeConfig,
  mergedBranches: readonly string[],
  emit: (event: MergeEvent) => void,
): Promise<{ readonly passed: boolean }> {
  if (!config.verify) return { passed: true };

  emit({ kind: "verify:started", branches: mergedBranches });

  try {
    const headResult = await gitRevParseHead(config.repoPath);
    const mergedRef = headResult.ok ? headResult.value : "unknown";
    const result = await config.verify(mergedRef, mergedBranches);

    if (result.passed) {
      emit({ kind: "verify:passed" });
    } else {
      emit({
        kind: "verify:failed",
        message: result.message ?? "Verification failed",
      });
    }

    return { passed: result.passed };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    emit({ kind: "verify:failed", message });
    return { passed: false };
  }
}

/**
 * Check if a branch tip matches expectedRef (stale-branch guard).
 * Returns a "skipped" outcome if stale, or undefined to proceed.
 */
async function checkStaleBranch(
  branchDef: MergeBranch,
  repoPath: string,
): Promise<BranchMergeOutcome | undefined> {
  if (branchDef.expectedRef === undefined) return undefined;

  const actual = await gitRevParseBranch(branchDef.name, repoPath);
  if (!actual.ok) {
    return { kind: "failed", error: actual.error };
  }

  if (actual.value !== branchDef.expectedRef) {
    return {
      kind: "skipped",
      reason: `Branch "${branchDef.name}" is stale: expected ${branchDef.expectedRef.slice(0, 8)}, actual ${actual.value.slice(0, 8)}`,
    };
  }

  return undefined;
}

/** Emit the appropriate event for a branch outcome. */
function emitOutcome(
  emit: (event: MergeEvent) => void,
  branch: string,
  outcome: BranchMergeOutcome,
): void {
  switch (outcome.kind) {
    case "merged":
      emit({ kind: "merge:completed", branch, commitSha: outcome.commitSha });
      break;
    case "conflict":
      emit({ kind: "merge:conflict", branch, files: outcome.conflictFiles });
      break;
    case "skipped":
      emit({ kind: "merge:skipped", branch, reason: outcome.reason });
      break;
    case "failed":
      emit({ kind: "merge:failed", branch, error: outcome.error });
      break;
    case "reverted":
      emit({ kind: "merge:reverted", branch, reason: outcome.reason });
      break;
  }
}

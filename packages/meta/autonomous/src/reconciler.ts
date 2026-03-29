/**
 * Task board reconciler — defense-in-depth consistency check.
 *
 * After spawn dispatch completes, compares the delegation bridge's board
 * (ground truth from actual worker execution) against the harness's board
 * (which may have missed transitions due to assignTask/completeTask failures).
 *
 * Called once on engine wake-up (after all workers complete), not on a timer.
 */

import type {
  AgentId,
  KoiError,
  Result,
  TaskBoard,
  TaskBoardSnapshot,
  TaskItemId,
} from "@koi/core";
import { agentId } from "@koi/core";
import type { AutonomousLogger } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  /** Number of tasks that were fixed. */
  readonly fixed: number;
  /** Human-readable descriptions of each fix applied. */
  readonly details: readonly string[];
}

export interface ReconcileHarness {
  readonly assignTask: (taskId: TaskItemId, workerId: AgentId) => Promise<Result<void, KoiError>>;
  readonly completeTask: (
    taskId: TaskItemId,
    result: { readonly taskId: TaskItemId; readonly output: string; readonly durationMs: number },
  ) => Promise<Result<void, KoiError>>;
  readonly failTask: (taskId: TaskItemId, error: KoiError) => Promise<Result<void, KoiError>>;
  readonly status: () => { readonly taskBoard: TaskBoardSnapshot };
}

// ---------------------------------------------------------------------------
// Reconciler
// ---------------------------------------------------------------------------

/**
 * Reconcile harness board against bridge board (ground truth).
 *
 * Handles these drift scenarios:
 * 1. Task completed in bridge but stuck as "assigned" or "pending" in harness
 * 2. Task failed in bridge but stuck as "assigned" or "pending" in harness
 * 3. Task assigned in bridge but still "pending" in harness (assign failed)
 *
 * Each fix is idempotent: if the harness already agrees with the bridge,
 * no action is taken.
 */
export async function reconcileTaskBoard(
  bridgeBoard: TaskBoard,
  harness: ReconcileHarness,
  logger?: AutonomousLogger | undefined,
): Promise<ReconcileResult> {
  const harnessSnapshot = harness.status().taskBoard;
  const details: string[] = [];

  for (const bridgeItem of bridgeBoard.all()) {
    const harnessItem = harnessSnapshot.items.find((i) => i.id === bridgeItem.id);
    if (harnessItem === undefined) continue;

    // Already in sync — skip.
    // Also check retry count: a retryable failure returns the task to "pending"
    // with incremented retries. If both are "pending" but retries differ, the
    // harness missed the failTask() transition that advances the retry counter.
    const retriesMatch = (harnessItem.retries ?? 0) === (bridgeItem.retries ?? 0);
    if (harnessItem.status === bridgeItem.status && retriesMatch) continue;

    // Scenario 1: Bridge says completed, harness disagrees
    if (bridgeItem.status === "completed" && harnessItem.status !== "completed") {
      const result = bridgeBoard.result(bridgeItem.id);
      if (result === undefined) continue;

      // Ensure task is assigned before completing (harness enforces status preconditions)
      if (harnessItem.status === "pending") {
        const workerId = bridgeItem.assignedTo ?? agentId(`worker-${bridgeItem.id}`);
        const assignResult = await harness.assignTask(bridgeItem.id, workerId);
        if (!assignResult.ok) {
          logger?.warn(
            `reconcile: cannot assign ${bridgeItem.id} (${harnessItem.status} → assigned): ${assignResult.error.message}`,
          );
          continue;
        }
      }

      const completeResult = await harness.completeTask(bridgeItem.id, {
        taskId: bridgeItem.id,
        output: result.output,
        durationMs: result.durationMs,
      });

      if (completeResult.ok) {
        const msg = `${bridgeItem.id}: ${harnessItem.status} → completed`;
        details.push(msg);
        logger?.warn(`reconciled task ${msg}`);
      } else {
        logger?.warn(
          `reconcile: completeTask failed for ${bridgeItem.id}: ${completeResult.error.message}`,
        );
      }
      continue;
    }

    // Scenario 2: Bridge says failed, harness disagrees
    if (
      bridgeItem.status === "failed" &&
      harnessItem.status !== "failed" &&
      bridgeItem.error !== undefined
    ) {
      if (harnessItem.status === "pending") {
        const workerId = bridgeItem.assignedTo ?? agentId(`worker-${bridgeItem.id}`);
        const assignResult = await harness.assignTask(bridgeItem.id, workerId);
        if (!assignResult.ok) {
          logger?.warn(
            `reconcile: cannot assign ${bridgeItem.id} before failing: ${assignResult.error.message}`,
          );
          continue;
        }
      }

      const failResult = await harness.failTask(bridgeItem.id, bridgeItem.error);
      if (failResult.ok) {
        const msg = `${bridgeItem.id}: ${harnessItem.status} → failed`;
        details.push(msg);
        logger?.warn(`reconciled task ${msg}`);
      } else {
        logger?.warn(
          `reconcile: failTask failed for ${bridgeItem.id}: ${failResult.error.message}`,
        );
      }
      continue;
    }

    // Scenario 3: Retry count drift — both "pending" but retries differ.
    // The bridge ran assign → spawn → fail(retryable) → back to pending with
    // retries incremented. The harness missed the assign+fail transitions, so
    // its retry counter is behind. Replay assign → fail to advance the counter.
    if (
      bridgeItem.status === "pending" &&
      harnessItem.status === "pending" &&
      (bridgeItem.retries ?? 0) > (harnessItem.retries ?? 0) &&
      bridgeItem.error !== undefined
    ) {
      const workerId = bridgeItem.assignedTo ?? agentId(`worker-${bridgeItem.id}`);
      const assignResult = await harness.assignTask(bridgeItem.id, workerId);
      if (!assignResult.ok) {
        logger?.warn(
          `reconcile: cannot assign ${bridgeItem.id} for retry sync: ${assignResult.error.message}`,
        );
        continue;
      }

      const failResult = await harness.failTask(bridgeItem.id, bridgeItem.error);
      if (failResult.ok) {
        const msg = `${bridgeItem.id}: retries ${String(harnessItem.retries ?? 0)} → ${String(bridgeItem.retries ?? 0)}`;
        details.push(msg);
        logger?.warn(`reconciled retry drift ${msg}`);
      } else {
        logger?.warn(
          `reconcile: failTask for retry sync failed for ${bridgeItem.id}: ${failResult.error.message}`,
        );
      }
    }
  }

  return { fixed: details.length, details };
}

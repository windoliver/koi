/**
 * recoverOrphanedTasks — coordinator restart recovery helper.
 *
 * When a coordinator crashes while children are running, the child tasks
 * remain in `in_progress` with `assignedTo` set to the old child agent IDs.
 * On restart, this helper kills each orphaned task then re-queues it as a
 * new pending task — processing one orphan at a time (sequential) to avoid
 * parallel kill-all races that would lose tasks on partial storage failure.
 *
 * Ordering: kill-then-add (ensures no duplicate live work):
 *   1. Kill original — no second agent can pick it up while replacement is pending.
 *   2. Add replacement — if this fails, the orphan was already killed (data loss).
 *      Surface in `failed` so the coordinator can investigate.
 *
 * Limitation: re-added tasks receive new IDs. A proper atomic `unassign/requeue`
 * on ManagedTaskBoard (L0) would preserve IDs and eliminate the data-loss window —
 * tracked for future implementation.
 */

import type { AgentId, ManagedTaskBoard, TaskItemId } from "@koi/core";
import { isTerminalTaskStatus } from "@koi/core";

export interface OrphanRecoveryResult {
  /** IDs of orphans that were killed AND replaced with a new pending task. */
  readonly killed: readonly TaskItemId[];
  /** IDs of new pending tasks created to replace killed orphans. */
  readonly requeued: readonly TaskItemId[];
  /**
   * IDs of orphaned tasks whose recovery failed. Two sub-cases:
   * (a) kill() failed and orphan is still in_progress — no replacement created.
   *     Original task is still alive; coordinator can retry on next restart.
   * (b) kill() succeeded but add() failed — orphan was killed but no replacement.
   *     The work is lost; coordinator should log and investigate.
   *
   * In both cases processing stops immediately to avoid further board operations
   * on what is likely a degraded store.
   */
  readonly failed: readonly TaskItemId[];
}

/**
 * Finds all in_progress tasks NOT assigned to coordinatorAgentId,
 * kills each, then re-queues a replacement pending task.
 *
 * Uses kill-then-add ordering per orphan to prevent duplicate live work:
 * - Kill first: prevents any parallel runner from picking up both copies.
 * - Add after: if add fails, the orphan was already killed (data loss); surface in failed.
 *
 * Stops at the first failure (kill or add) to avoid further operations on a
 * degraded store. Remaining orphans are left untouched and will be re-discovered
 * on the next coordinator restart.
 */
export async function recoverOrphanedTasks(
  board: ManagedTaskBoard,
  coordinatorAgentId: AgentId,
): Promise<OrphanRecoveryResult> {
  const snapshot = board.snapshot();
  const orphans = snapshot
    .all()
    .filter((t) => t.status === "in_progress" && t.assignedTo !== coordinatorAgentId);

  if (orphans.length === 0) {
    return { killed: [], requeued: [], failed: [] };
  }

  const killed: TaskItemId[] = [];
  const requeued: TaskItemId[] = [];
  const failed: TaskItemId[] = [];

  for (const orphan of orphans) {
    // Step 1: Kill the original before creating a replacement.
    // This prevents a window where both the original and the replacement are schedulable.
    const killResult = await board.kill(orphan.id);
    if (!killResult?.ok) {
      // kill() returned non-ok. Check current state to distinguish:
      // (a) Already terminal (concurrent kill): safe to skip, no replacement needed.
      // (b) Still in_progress: store is degraded. Stop and report failure.
      const currentStatus = board.snapshot().get(orphan.id)?.status;
      if (currentStatus !== undefined && isTerminalTaskStatus(currentStatus)) {
        // Case (a): already terminal — no replacement needed, no data loss.
        continue;
      }
      // Case (b): original still live — degraded store. Stop processing.
      failed.push(orphan.id);
      break;
    }

    // Step 2: Allocate and persist the replacement now that the original is terminal.
    // If either step fails, the orphan was already killed — surface as failed (data loss).
    const newId = await board.nextId();
    if (newId === undefined) {
      failed.push(orphan.id);
      break;
    }

    const addResult = await board.add({
      id: newId,
      subject: orphan.subject,
      description: orphan.description,
      ...(orphan.dependencies.length > 0 ? { dependencies: orphan.dependencies } : {}),
      ...(orphan.metadata !== undefined ? { metadata: orphan.metadata } : {}),
    });

    if (!addResult.ok) {
      // Original was killed but replacement failed — the work is lost.
      // Stop and surface in failed so the coordinator can investigate.
      failed.push(orphan.id);
      break;
    }

    killed.push(orphan.id);
    requeued.push(newId);
  }

  return { killed, requeued, failed };
}

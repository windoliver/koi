/**
 * recoverOrphanedTasks — coordinator restart recovery helper.
 *
 * When a coordinator crashes while children are running, the child tasks
 * remain in `in_progress` with `assignedTo` set to the old child agent IDs.
 * On restart, this helper re-queues each orphaned task as a new pending task
 * before killing the original — ensuring no work is lost even if the board
 * store is degraded during recovery.
 *
 * Limitation: re-added tasks receive new IDs. This is acceptable for MVP;
 * a proper `unassign(taskId)` on ManagedTaskBoard (L0) would preserve IDs —
 * tracked for future implementation.
 */

import type { AgentId, ManagedTaskBoard, TaskItemId } from "@koi/core";
import { isTerminalTaskStatus } from "@koi/core";

export interface OrphanRecoveryResult {
  /** IDs of tasks that were killed (now terminal). */
  readonly killed: readonly TaskItemId[];
  /** IDs of new pending tasks created to replace the killed ones. */
  readonly requeued: readonly TaskItemId[];
  /**
   * IDs of orphaned tasks that could NOT be recovered (nextId or board.add() failed).
   * The original task is still alive when this happens — no data loss occurred.
   * Recovery stops at the first failure to avoid further board operations on a
   * degraded store. Coordinator should log and retry on next restart.
   */
  readonly failed: readonly TaskItemId[];
}

/**
 * Finds all in_progress tasks NOT assigned to coordinatorAgentId,
 * re-queues each as a new pending task, then kills the original.
 *
 * Processes tasks sequentially with add-then-kill ordering:
 * 1. Allocate a new ID for the replacement task
 * 2. Add the replacement task (pending) — if this fails, stop and report failure
 * 3. Kill the original — the replacement is already persisted, so the work is safe
 *
 * This ordering ensures no data loss: if add() fails, the original task remains
 * alive and will be re-discovered on the next coordinator restart. Recovery stops
 * at the first add failure to avoid further operations on a degraded store.
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
    // Step 1: allocate a replacement ID.
    const newId = await board.nextId();
    if (newId === undefined) {
      // ID allocation failed — board is degraded. Stop processing.
      failed.push(orphan.id);
      break;
    }

    // Step 2: persist the replacement task BEFORE killing the original.
    // If this fails, the original task is still alive — no data loss.
    const addResult = await board.add({
      id: newId,
      subject: orphan.subject,
      description: orphan.description,
      ...(orphan.dependencies.length > 0 ? { dependencies: orphan.dependencies } : {}),
      ...(orphan.metadata !== undefined ? { metadata: orphan.metadata } : {}),
    });

    if (!addResult.ok) {
      // Replacement could not be persisted — stop to avoid further board operations.
      // Original task remains alive and will be re-discovered on next restart.
      failed.push(orphan.id);
      break;
    }

    requeued.push(newId);

    // Step 3: kill the original now that the replacement is safely persisted.
    const killResult = await board.kill(orphan.id);
    if (killResult?.ok) {
      killed.push(orphan.id);
    } else {
      // kill() returned non-ok. Two cases:
      // (a) Task already reached a terminal state concurrently — replacement is valid, no duplication.
      // (b) Transient store error — original still in_progress alongside the new replacement.
      //     Case (b) creates duplicate live work, so we roll back the replacement and report failure.
      const currentStatus = board.snapshot().get(orphan.id)?.status;
      if (currentStatus !== undefined && isTerminalTaskStatus(currentStatus)) {
        // Case (a): already terminal — replacement pending is safe. No entry in killed.
      } else {
        // Case (b): original still live. Kill the just-added replacement to prevent duplication.
        await board.kill(newId); // best-effort cleanup
        requeued.pop(); // undo the requeued push for newId
        failed.push(orphan.id);
        break; // stop further recovery on a degraded store
      }
    }
  }

  return { killed, requeued, failed };
}

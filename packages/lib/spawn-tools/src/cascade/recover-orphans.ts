/**
 * recoverOrphanedTasks — coordinator restart recovery helper.
 *
 * When a coordinator crashes while children are running, the child tasks
 * remain in `in_progress` with `assignedTo` set to the old child agent IDs.
 * On restart, this helper unassigns each orphaned task, resetting it to
 * `pending` so the new coordinator can safely re-delegate it.
 *
 * Uses `board.unassign()` — an atomic in_progress → pending transition that
 * preserves the task ID. No kill, no new task creation: no data-loss window
 * and no duplicate-live-work window.
 */

import type { AgentId, ManagedTaskBoard, TaskItemId } from "@koi/core";

export interface OrphanRecoveryResult {
  /**
   * IDs of orphaned tasks that were successfully unassigned (now pending).
   * Same IDs as the original tasks — task IDs are preserved by unassign().
   */
  readonly requeued: readonly TaskItemId[];
  /**
   * IDs of orphaned tasks that could NOT be recovered (unassign() failed).
   * The original task remains in_progress. Coordinator should log and retry
   * on the next restart; processing stops at the first failure to avoid
   * further operations on a potentially degraded store.
   */
  readonly failed: readonly TaskItemId[];
  /**
   * Always empty — kept for interface compatibility.
   * unassign() does not kill tasks, so nothing appears here.
   * @deprecated Use `requeued` to identify recovered tasks.
   */
  readonly killed: readonly TaskItemId[];
}

/**
 * Finds all in_progress tasks NOT assigned to coordinatorAgentId and
 * unassigns each one, atomically resetting it to pending.
 *
 * Processing is sequential: stops at the first unassign() failure so the
 * remaining orphans are left untouched and will be re-discovered on the
 * next coordinator restart.
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

  const requeued: TaskItemId[] = [];
  const failed: TaskItemId[] = [];

  for (const orphan of orphans) {
    // unassign() is an atomic in_progress → pending transition.
    // Same task ID is preserved — no data-loss or duplicate-task risks.
    const result = await board.unassign(orphan.id);
    if (result.ok) {
      requeued.push(orphan.id);
    } else {
      // unassign() failed — store may be degraded. Stop processing.
      failed.push(orphan.id);
      break;
    }
  }

  return { killed: [], requeued, failed };
}

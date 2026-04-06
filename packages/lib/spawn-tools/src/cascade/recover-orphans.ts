/**
 * recoverOrphanedTasks — coordinator restart recovery helper.
 *
 * When a coordinator crashes while children are running, the child tasks
 * remain in `in_progress` with `assignedTo` set to the old child agent IDs.
 * On restart, this helper kills each orphaned task and re-adds an equivalent
 * pending task so the coordinator can re-delegate.
 *
 * Limitation: re-added tasks receive new IDs. This is acceptable for MVP;
 * a proper `unassign(taskId)` on ManagedTaskBoard (L0) would preserve IDs —
 * tracked for future implementation.
 */

import type { AgentId, ManagedTaskBoard, TaskItemId } from "@koi/core";

export interface OrphanRecoveryResult {
  /** IDs of tasks that were killed (now terminal). */
  readonly killed: readonly TaskItemId[];
  /** IDs of new pending tasks created to replace the killed ones. */
  readonly requeued: readonly TaskItemId[];
  /**
   * IDs of tasks that were killed but could NOT be requeued (board.add() failed).
   * Non-empty indicates data loss — coordinator should log and alert on this field.
   */
  readonly failed: readonly TaskItemId[];
}

/**
 * Finds all in_progress tasks NOT assigned to coordinatorAgentId,
 * kills them, and re-adds equivalent pending tasks.
 *
 * Kills and ID allocations are parallelised with Promise.all for O(1) latency
 * regardless of orphan count — important when the board is Nexus-backed.
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

  // Phase 1: kill all orphans in parallel.
  const killResults = await Promise.all(orphans.map((t) => board.kill(t.id)));

  // Collect successfully killed tasks paired with their original metadata.
  const killedOrphans: Array<{ id: TaskItemId; task: (typeof orphans)[0] }> = [];
  for (let i = 0; i < killResults.length; i++) {
    const result = killResults[i];
    const orphan = orphans[i];
    if (result?.ok && orphan !== undefined) {
      killedOrphans.push({ id: orphan.id, task: orphan });
    }
    // Kill failures (already terminal) are silently skipped — the task is already
    // in a terminal state; no requeue is needed or possible.
  }

  if (killedOrphans.length === 0) {
    return { killed: [], requeued: [], failed: [] };
  }

  // Phase 2: allocate new IDs and re-add all killed tasks in parallel.
  const newIds = await Promise.all(killedOrphans.map(() => board.nextId()));

  const addResults = await Promise.all(
    killedOrphans.map(({ task }, i) => {
      const newId = newIds[i];
      if (newId === undefined) return Promise.resolve({ ok: false as const });
      return board.add({
        id: newId,
        subject: task.subject,
        description: task.description,
        ...(task.dependencies.length > 0 ? { dependencies: task.dependencies } : {}),
        ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
      });
    }),
  );

  const killed: TaskItemId[] = [];
  const requeued: TaskItemId[] = [];
  const failed: TaskItemId[] = [];

  for (let i = 0; i < killedOrphans.length; i++) {
    const entry = killedOrphans[i];
    const addResult = addResults[i];
    const newId = newIds[i];
    if (entry === undefined || addResult === undefined || newId === undefined) continue;

    killed.push(entry.id);
    if (addResult.ok) {
      requeued.push(newId);
    } else {
      // Kill succeeded but requeue failed — task is lost. Caller must handle.
      failed.push(entry.id);
    }
  }

  return { killed, requeued, failed };
}

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
}

/**
 * Finds all in_progress tasks NOT assigned to coordinatorAgentId,
 * kills them, and re-adds equivalent pending tasks.
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
    return { killed: [], requeued: [] };
  }

  const killed: TaskItemId[] = [];
  const requeued: TaskItemId[] = [];

  for (const task of orphans) {
    // Kill the orphaned in_progress task (transitions to terminal `killed`)
    const killResult = await board.kill(task.id);
    if (!killResult.ok) {
      // If kill fails (e.g. already terminal), skip re-queue
      continue;
    }
    killed.push(task.id);

    // Re-add as a fresh pending task with the same description + subject
    const newId = await board.nextId();
    const addResult = await board.add({
      id: newId,
      subject: task.subject,
      description: task.description,
      ...(task.dependencies.length > 0 ? { dependencies: task.dependencies } : {}),
      ...(task.metadata !== undefined ? { metadata: task.metadata } : {}),
    });
    if (addResult.ok) {
      requeued.push(newId);
    }
  }

  return { killed, requeued };
}

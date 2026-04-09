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
 *
 * **Stale-worker window**: between unassign() and the coordinator's next
 * task_delegate call, the task is in `pending` state with no owner. A stale
 * child that survived the coordinator crash could theoretically call
 * task_update on the task during this window. In practice this window is very
 * short (recovery runs before the coordinator enters its delegation loop) and
 * requires the stale worker to act on a task ID it was no longer assigned to.
 * A future enhancement will add generation tokens to owned board mutations to
 * close this gap without requiring process-level coordination.
 *
 * **Error handling**
 * - Per-task races (NOT_FOUND, VALIDATION): the task was completed or removed
 *   concurrently (e.g. a surviving worker finished during recovery). Skip and
 *   continue — this is normal, not store degradation.
 * - Store-layer errors (EXTERNAL, INTERNAL): the store may be degraded. Stop
 *   processing remaining orphans and report the failing task in `failed`.
 * - CONFLICT: treated as a per-task race — skip and continue.
 */

import type { AgentId, KoiError, ManagedTaskBoard, Task, TaskItemId } from "@koi/core";

/**
 * Error codes that indicate a per-task state change rather than store degradation.
 *
 * NOT_FOUND  — task was deleted (task was removed, a clean end state)
 * VALIDATION — task is no longer in_progress (it completed/failed during recovery)
 *
 * CONFLICT is intentionally NOT included here: a CONFLICT from ManagedTaskBoard
 * means the board's persistence layer saw a version conflict — this is a real store
 * error, not a benign race, and should stop recovery.
 */
const TASK_RACE_CODES = new Set<KoiError["code"]>(["NOT_FOUND", "VALIDATION"]);

/**
 * Extract `metadata.delegatedTo` as a string, or `undefined` if absent/malformed.
 * The delegation record is set by `task_delegate` in `@koi/task-tools` as part
 * of the two-package coordinator-fan-out contract.
 */
function readDelegatedTo(task: Task): string | undefined {
  const raw = task.metadata?.delegatedTo;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export interface OrphanRecoveryResult {
  /**
   * IDs of orphaned tasks that were successfully unassigned (now pending).
   * Same IDs as the original tasks — task IDs are preserved by unassign().
   */
  readonly requeued: readonly TaskItemId[];
  /**
   * IDs of orphaned tasks that could NOT be recovered (unassign() failed with
   * a store-layer error). The original task may be in an indeterminate state.
   * The coordinator should log and retry on the next restart; processing stops
   * at the first store-layer failure to avoid further ops on a degraded store.
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
 * Per-task races (NOT_FOUND, VALIDATION, CONFLICT) are skipped — a surviving
 * worker completing its task during recovery is benign. Processing only stops
 * on genuine store-layer errors (EXTERNAL, INTERNAL).
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
    } else if (TASK_RACE_CODES.has(result.error.code)) {
      // Task changed state concurrently (completed/failed/vanished during recovery).
      // This is normal — a surviving worker may have finished its work.
      // Skip this orphan and continue recovering the rest.
      continue;
    } else {
      // Store-layer error (EXTERNAL/INTERNAL) — stop to avoid further ops
      // on a potentially degraded store. Caller should retry on next restart.
      failed.push(orphan.id);
      break;
    }
  }

  return { killed: [], requeued, failed };
}

// ---------------------------------------------------------------------------
// Stale delegation cleanup (#1557 review fix 4A revised)
// ---------------------------------------------------------------------------
//
// `task_delegate` (in `@koi/task-tools`) records a coordinator's intent to
// assign a pending task to a child agent by writing `metadata.delegatedTo`.
// The task stays `pending` with no `assignedTo` until the child claims it
// via `task_update(status: "in_progress")`. If the child crashes or never
// spawns, the task sits with a stale `delegatedTo` forever — blocking any
// future attempt to re-delegate it (task_delegate rejects tasks that are
// already delegated).
//
// `recoverOrphanedTasks` above handles the `in_progress` side of the split:
// tasks whose running worker is no longer alive. This function handles the
// `pending` side: tasks whose intended worker never claimed them.
//
// The two together form the complete delegation recovery contract. Both
// should be called by a coordinator on restart, in order:
//   1. `recoverOrphanedTasks(board, currentCoordinator)` — unassign in_progress
//   2. `recoverStaleDelegations(board, liveAgentIds)` — clear pending delegations

export interface StaleDelegationResult {
  /**
   * Task IDs whose `metadata.delegatedTo` was cleared because the delegated
   * agent is not in the live set. Each task is still `pending` — the caller
   * may now re-delegate via a fresh `task_delegate` call.
   */
  readonly cleared: readonly TaskItemId[];
  /**
   * Task IDs whose metadata patch failed with a store-layer error. Processing
   * stops at the first store-layer failure; the caller should log and retry.
   */
  readonly failed: readonly TaskItemId[];
}

/**
 * Find every pending task whose `metadata.delegatedTo` points at an agent
 * that is NOT in `liveAgentIds`, and clear that field so the task can be
 * re-delegated.
 *
 * `liveAgentIds` should contain the IDs of every child agent that the new
 * coordinator believes is currently alive. A common choice is "empty set"
 * (clear every stale delegation unconditionally) for a cold restart, or
 * the output of an agent-registry scan for a warm restart.
 *
 * Per-task races (NOT_FOUND, VALIDATION) are skipped — the task may have
 * completed/failed between the snapshot read and the update. Store-layer
 * errors (EXTERNAL, INTERNAL, CONFLICT) stop processing and are reported
 * in `failed`.
 *
 * Design note: this is a no-op for tasks that are NOT pending, so it's
 * safe to call alongside `recoverOrphanedTasks` in either order.
 */
export async function recoverStaleDelegations(
  board: ManagedTaskBoard,
  liveAgentIds: ReadonlySet<string>,
): Promise<StaleDelegationResult> {
  const snapshot = board.snapshot();
  const stale = snapshot.pending().filter((task) => {
    const delegatedTo = readDelegatedTo(task);
    return delegatedTo !== undefined && !liveAgentIds.has(delegatedTo);
  });
  if (stale.length === 0) {
    return { cleared: [], failed: [] };
  }

  const cleared: TaskItemId[] = [];
  const failed: TaskItemId[] = [];

  for (const task of stale) {
    // Build a new metadata object without delegatedTo — preserve every other key.
    const existing = task.metadata ?? {};
    const nextMetadata: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(existing)) {
      if (k !== "delegatedTo") nextMetadata[k] = v;
    }
    const result = await board.update(task.id, { metadata: nextMetadata });
    if (result.ok) {
      cleared.push(task.id);
    } else if (TASK_RACE_CODES.has(result.error.code)) {
      // Benign per-task race — task completed/disappeared between snapshot and patch.
      continue;
    } else {
      // Store-layer error — stop to avoid further ops on a degraded store.
      failed.push(task.id);
      break;
    }
  }

  return { cleared, failed };
}

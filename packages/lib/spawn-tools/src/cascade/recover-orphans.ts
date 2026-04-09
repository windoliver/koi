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
import { isTerminalTaskStatus } from "@koi/core";

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
// future attempt to re-delegate it (`task_delegate` rejects ANY task that
// already has a `delegatedTo` key set, regardless of type or value).
//
// **Ordering is intentionally order-independent.** This helper scans every
// non-terminal task (both `pending` AND `in_progress`) with a `delegatedTo`
// key, not only pending tasks, because:
//
//   1. `assign()` moves a delegated task to `in_progress` WITHOUT clearing
//      metadata.delegatedTo — the marker persists.
//   2. `unassign()` (used by `recoverOrphanedTasks`) also preserves metadata.
//   3. So if a child claimed a delegation and then crashed, the task's
//      `delegatedTo` is still set even after orphan recovery runs.
//
// A "pending-only" scan would miss those tasks if this helper runs before
// orphan recovery, leaving them permanently undelegatable. Scanning all
// non-terminal tasks fixes the ordering sensitivity.
//
// Malformed values (non-string, empty string, null) are ALSO cleared because
// `task_delegate` rejects any present `delegatedTo` key. A legacy/corrupted
// value that passed a shape check would still block delegation; a recovery
// pass that "reported success" while leaving it untouched is a silent trap.

export interface StaleDelegationResult {
  /**
   * Task IDs whose `metadata.delegatedTo` was cleared. Each task keeps its
   * original status (`pending` or `in_progress`) — only the delegation marker
   * is removed. Callers may now re-delegate pending tasks via a fresh
   * `task_delegate` call.
   */
  readonly cleared: readonly TaskItemId[];
  /**
   * Task IDs whose metadata patch failed with a store-layer error. Processing
   * stops at the first store-layer failure; the caller should log and retry.
   */
  readonly failed: readonly TaskItemId[];
}

/**
 * Predicate: should this task's `metadata.delegatedTo` be cleared?
 *
 * Clears if the key is PRESENT on the metadata object AND one of:
 *  - the value is not a non-empty string (malformed — task_delegate would
 *    still reject it because the key exists), OR
 *  - the value IS a non-empty string but the referenced agent is not in
 *    `liveAgentIds` (stale — the delegated worker is gone).
 *
 * Skips terminal tasks (completed/failed/killed) because the board rejects
 * update() on those, and the delegation history is harmless there anyway.
 */
function needsClear(task: Task, liveAgentIds: ReadonlySet<string>): boolean {
  if (isTerminalTaskStatus(task.status)) return false;
  const metadata = task.metadata;
  if (metadata === undefined || !("delegatedTo" in metadata)) return false;
  const value = metadata.delegatedTo;
  if (typeof value !== "string" || value.length === 0) {
    // Malformed marker — always clear (task_delegate would reject the task
    // as "already delegated" regardless of the value's type).
    return true;
  }
  return !liveAgentIds.has(value);
}

/**
 * Find every non-terminal task whose `metadata.delegatedTo` is stale or
 * malformed and clear that field so the task can be re-delegated.
 *
 * `liveAgentIds` should contain the IDs of every child agent that the new
 * coordinator believes is currently alive. A common choice is "empty set"
 * (clear every delegation unconditionally) for a cold restart, or the output
 * of an agent-registry scan for a warm restart.
 *
 * Per-task races (NOT_FOUND, VALIDATION) are skipped — the task may have
 * completed/failed between the snapshot read and the update. Store-layer
 * errors (EXTERNAL, INTERNAL, CONFLICT) stop processing and are reported
 * in `failed`.
 *
 * **Ordering is safe in either direction** with respect to
 * `recoverOrphanedTasks`. The helper scans both `pending` and `in_progress`
 * tasks, so a delegation that was claimed by a crashed child is cleared
 * whether this helper runs before or after orphan recovery.
 */
export async function recoverStaleDelegations(
  board: ManagedTaskBoard,
  liveAgentIds: ReadonlySet<string>,
): Promise<StaleDelegationResult> {
  const snapshot = board.snapshot();
  const stale = snapshot.all().filter((task) => needsClear(task, liveAgentIds));
  if (stale.length === 0) {
    return { cleared: [], failed: [] };
  }

  const cleared: TaskItemId[] = [];
  const failed: TaskItemId[] = [];

  for (const task of stale) {
    // Build a new metadata object without delegatedTo — preserve every other key.
    // Use destructuring so we don't need to iterate and filter; the rest is a
    // shallow clone of every other metadata property.
    const { delegatedTo: _discard, ...nextMetadata } = (task.metadata ?? {}) as Record<
      string,
      unknown
    >;
    void _discard;
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

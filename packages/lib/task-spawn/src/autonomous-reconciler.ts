import type { Task, TaskBoardSnapshot, TaskItemId } from "@koi/core";
import { deserializeBoard, snapshotToItemsMap, topologicalSort } from "@koi/task-board";

export type AutonomousReconcileAction =
  | {
      readonly kind: "dispatch";
      readonly taskId: TaskItemId;
      readonly agentType: string;
      /**
       * Snapshot of `task.version` at reconciliation time. Callers MUST use
       * this as an OCC token when claiming/delegating the task before spawn
       * so duplicate dispatches across concurrent reconcilers are rejected.
       */
      readonly version: number;
    }
  | {
      readonly kind: "clearDelegation";
      readonly taskId: TaskItemId;
      readonly delegatedTo: string;
      /** OCC token — the task.version observed when the action was emitted. */
      readonly version: number;
    }
  | {
      readonly kind: "cancelDownstream";
      readonly taskId: TaskItemId;
      readonly blockedBy: TaskItemId;
      readonly reason: "upstream-failed" | "upstream-killed";
      /** OCC token — the task.version observed when the action was emitted. */
      readonly version: number;
    }
  | {
      /**
       * Live (in_progress) descendant of a failed/killed ancestor. Carries
       * the assigned agent so consumers can drive `killOwnedTask(owner, ...)`
       * or equivalent lease-aware revocation; pure status/owner-blind
       * cancellation is not safe here.
       */
      readonly kind: "revokeOwnedDownstream";
      readonly taskId: TaskItemId;
      readonly blockedBy: TaskItemId;
      readonly reason: "upstream-failed" | "upstream-killed";
      readonly owner: string;
      readonly version: number;
    }
  | {
      /**
       * Live (in_progress) descendant whose owner cannot be derived from
       * the snapshot (assignedTo and lastAssignedTo both unset — legacy or
       * corrupt persisted state). The caller MUST positively fence the live
       * worker out of band before applying any terminal mutation; the
       * reconciler refuses to emit a plain cancellation here so a worker
       * cannot keep running after its ancestor has already failed.
       */
      readonly kind: "escalateOrphanedDownstream";
      readonly taskId: TaskItemId;
      readonly blockedBy: TaskItemId;
      readonly reason: "upstream-failed" | "upstream-killed";
      readonly version: number;
    };

export interface AutonomousReconcileResult {
  readonly actions: readonly AutonomousReconcileAction[];
  /**
   * Task IDs that the reconciler could not order because the persisted graph
   * is not a DAG (e.g. cycle, missing dependency). Recovery actions are
   * intentionally NOT emitted for these tasks; the caller must surface the
   * malformed-board state to operators before any further autonomous run.
   */
  readonly unorderedTaskIds: readonly TaskItemId[];
}

export interface AutonomousReconcileOptions {
  readonly isDelegationStale?: ((task: Task, delegatedTo: string) => boolean) | undefined;
}

function metadataString(task: Task, key: string): string | undefined {
  const value = task.metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function delegatedAgentType(task: Task): string | undefined {
  if (task.status !== "pending") return undefined;
  // Dispatch still requires an explicit agent target — either via the
  // explicit `delegation: "spawn"` + `agentType` shape, or via the
  // task_delegate persisted shape (`agentType` on a pending task that
  // also carries `delegatedTo`).
  const agentType = metadataString(task, "agentType");
  if (agentType === undefined) return undefined;
  if (task.metadata?.delegation === "spawn") return agentType;
  if (Object.hasOwn(task.metadata ?? {}, "delegatedTo")) return agentType;
  return undefined;
}

interface DelegationMarker {
  readonly delegatedTo: string;
  readonly malformed: boolean;
}

function pendingDelegationMarker(task: Task): DelegationMarker | undefined {
  if (task.status !== "pending") return undefined;
  if (task.metadata === undefined) return undefined;
  if (!Object.hasOwn(task.metadata, "delegatedTo")) return undefined;
  // Recover delegations from any known writer: the autonomous spawn shape
  // (`delegation: "spawn"`) and the task_delegate persisted shape (carries
  // `agentType` alongside `delegatedTo`). A pending task with only an
  // unrelated `delegatedTo` field and no other delegation signal is left
  // alone — that data may belong to an external/domain consumer.
  const isSpawnShape = task.metadata.delegation === "spawn";
  const isDelegateShape = metadataString(task, "agentType") !== undefined;
  if (!isSpawnShape && !isDelegateShape) return undefined;
  const raw = task.metadata.delegatedTo;
  if (typeof raw === "string" && raw.length > 0) {
    return { delegatedTo: raw, malformed: false };
  }
  return { delegatedTo: typeof raw === "string" ? raw : String(raw), malformed: true };
}

export function reconcileTaskBoard(
  snapshot: TaskBoardSnapshot,
  options: AutonomousReconcileOptions = {},
): AutonomousReconcileResult {
  const board = deserializeBoard(snapshot);
  const itemsMap = snapshotToItemsMap(board);
  const orderedIds = topologicalSort(itemsMap);
  const orderedSet = new Set<TaskItemId>(orderedIds);
  const unorderedSet = new Set<TaskItemId>();
  for (const id of itemsMap.keys()) {
    if (!orderedSet.has(id)) unorderedSet.add(id);
  }
  // Tasks with dependencies that no longer exist on the board: topological
  // sort silently treats them as having indegree 0, so the reconciler would
  // otherwise try to dispatch/cancel them as if the dep were satisfied.
  // Surface them as malformed so the caller fails closed.
  for (const [id, task] of itemsMap) {
    for (const depId of task.dependencies) {
      if (!itemsMap.has(depId)) {
        unorderedSet.add(id);
        break;
      }
    }
  }
  const unorderedTaskIds: TaskItemId[] = [...unorderedSet];
  const readyIds = new Set(board.ready().map((task) => task.id));
  const actions: AutonomousReconcileAction[] = [];
  const isStale = options.isDelegationStale;

  const activeDelegations = new Set<TaskItemId>();
  const recoveringIds = new Set<TaskItemId>();
  for (const task of board.all()) {
    if (unorderedSet.has(task.id)) continue;
    const marker = pendingDelegationMarker(task);
    if (marker === undefined) continue;
    const stale = marker.malformed || (isStale?.(task, marker.delegatedTo) ?? false);
    if (stale) {
      // clearDelegation mutates task.version. The same dispatch can not be
      // emitted in this pass because its OCC token would already be stale by
      // the time the consumer applied the cleanup. Callers run reconciliation
      // again after applying clearDelegation to pick up the redispatch.
      recoveringIds.add(task.id);
      actions.push({
        kind: "clearDelegation",
        taskId: task.id,
        delegatedTo: marker.delegatedTo,
        version: task.version,
      });
    } else {
      activeDelegations.add(task.id);
    }
  }

  for (const taskId of orderedIds) {
    if (!readyIds.has(taskId)) continue;
    if (unorderedSet.has(taskId)) continue;
    if (activeDelegations.has(taskId) || recoveringIds.has(taskId)) continue;
    const task = board.get(taskId);
    if (task === undefined) continue;
    const agentType = delegatedAgentType(task);
    if (agentType === undefined) continue;
    actions.push({ kind: "dispatch", taskId, agentType, version: task.version });
  }

  interface CancellationOrigin {
    readonly blockedBy: TaskItemId;
    readonly reason: "upstream-failed" | "upstream-killed";
  }
  const cancelled = new Map<TaskItemId, CancellationOrigin>();
  for (const taskId of orderedIds) {
    if (unorderedSet.has(taskId)) continue;
    const task = board.get(taskId);
    if (task === undefined) continue;
    if (task.status !== "pending" && task.status !== "in_progress") continue;
    // A task already receiving clearDelegation in this pass cannot also carry
    // a version-locked cancel/revoke action — applying clearDelegation bumps
    // task.version and would invalidate the OCC token. Defer to a follow-up
    // reconciliation after the cleanup mutation lands.
    if (recoveringIds.has(taskId)) continue;
    for (const depId of task.dependencies) {
      const dep = board.get(depId);
      if (dep === undefined) continue;
      let origin: CancellationOrigin | undefined;
      if (dep.status === "killed") {
        origin = { blockedBy: depId, reason: "upstream-killed" };
      } else if (dep.status === "failed") {
        origin = { blockedBy: depId, reason: "upstream-failed" };
      } else {
        const inherited = cancelled.get(depId);
        if (inherited !== undefined) origin = inherited;
      }
      if (origin === undefined) continue;
      cancelled.set(taskId, origin);
      if (task.status === "in_progress") {
        const owner =
          (typeof task.assignedTo === "string" ? task.assignedTo : undefined) ??
          (typeof task.lastAssignedTo === "string" ? task.lastAssignedTo : undefined);
        if (owner !== undefined) {
          actions.push({
            kind: "revokeOwnedDownstream",
            taskId,
            blockedBy: origin.blockedBy,
            reason: origin.reason,
            owner,
            version: task.version,
          });
        } else {
          actions.push({
            kind: "escalateOrphanedDownstream",
            taskId,
            blockedBy: origin.blockedBy,
            reason: origin.reason,
            version: task.version,
          });
        }
        break;
      }
      actions.push({
        kind: "cancelDownstream",
        taskId,
        blockedBy: origin.blockedBy,
        reason: origin.reason,
        version: task.version,
      });
      break;
    }
  }

  return { actions, unorderedTaskIds };
}

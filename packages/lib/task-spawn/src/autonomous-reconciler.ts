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
    };

export interface AutonomousReconcileResult {
  readonly actions: readonly AutonomousReconcileAction[];
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
  if (task.metadata?.delegation !== "spawn") return undefined;
  return metadataString(task, "agentType");
}

interface DelegationMarker {
  readonly delegatedTo: string;
  readonly malformed: boolean;
}

function pendingDelegationMarker(task: Task): DelegationMarker | undefined {
  if (task.status !== "pending") return undefined;
  if (task.metadata === undefined) return undefined;
  // Only treat tasks that are explicitly spawn-delegated as autonomous
  // recovery state. Otherwise an unrelated domain-level `delegatedTo` field
  // would be silently cleared as if it were a stale spawn marker.
  if (task.metadata.delegation !== "spawn") return undefined;
  if (!Object.hasOwn(task.metadata, "delegatedTo")) return undefined;
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
  const orderedIds = topologicalSort(snapshotToItemsMap(board));
  const readyIds = new Set(board.ready().map((task) => task.id));
  const actions: AutonomousReconcileAction[] = [];
  const isStale = options.isDelegationStale;

  const activeDelegations = new Set<TaskItemId>();
  const recoveringIds = new Set<TaskItemId>();
  for (const task of board.all()) {
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
      if (task.status === "in_progress" && typeof task.assignedTo === "string") {
        actions.push({
          kind: "revokeOwnedDownstream",
          taskId,
          blockedBy: origin.blockedBy,
          reason: origin.reason,
          owner: task.assignedTo,
          version: task.version,
        });
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

  return { actions };
}

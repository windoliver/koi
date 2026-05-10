import type { Task, TaskBoardSnapshot, TaskItemId } from "@koi/core";
import { deserializeBoard, snapshotToItemsMap, topologicalSort } from "@koi/task-board";

export type AutonomousReconcileAction =
  | { readonly kind: "dispatch"; readonly taskId: TaskItemId; readonly agentType: string }
  | {
      readonly kind: "clearDelegation";
      readonly taskId: TaskItemId;
      readonly delegatedTo: string;
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
  const itemsById = new Map<TaskItemId, Task>(snapshot.items.map((task) => [task.id, task]));
  const orderedIds = topologicalSort(snapshotToItemsMap(board));
  const readyIds = new Set(board.ready().map((task) => task.id));
  const recoveringIds = new Set<TaskItemId>();
  const actions: AutonomousReconcileAction[] = [];
  const isStale = options.isDelegationStale;

  const activeDelegations = new Set<TaskItemId>();
  for (const task of snapshot.items) {
    const marker = pendingDelegationMarker(task);
    if (marker === undefined) continue;
    const stale = marker.malformed || (isStale?.(task, marker.delegatedTo) ?? false);
    if (stale) {
      recoveringIds.add(task.id);
      actions.push({
        kind: "clearDelegation",
        taskId: task.id,
        delegatedTo: marker.delegatedTo,
      });
    } else {
      activeDelegations.add(task.id);
    }
  }

  for (const taskId of orderedIds) {
    if (!readyIds.has(taskId)) continue;
    if (recoveringIds.has(taskId) || activeDelegations.has(taskId)) continue;
    const task = itemsById.get(taskId);
    if (task === undefined) continue;
    const agentType = delegatedAgentType(task);
    if (agentType === undefined) continue;
    actions.push({ kind: "dispatch", taskId, agentType });
  }

  return { actions };
}

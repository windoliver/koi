/**
 * Task board admin adapter for the Koi dashboard.
 *
 * Wraps a structurally-typed TaskBoard (or its snapshot) to produce
 * dashboard-compatible views (RuntimeViewDataSource['taskBoard']).
 *
 * Uses structural typing to avoid direct dependency on @koi/task-board —
 * the consumer injects a compatible board or snapshot provider at runtime.
 *
 * L2 package: imports from @koi/core and @koi/dashboard-types only.
 */

import type {
  TaskBoardSnapshot as DashboardTaskBoardSnapshot,
  RuntimeViewDataSource,
  TaskBoardEdge,
  TaskBoardNode,
} from "@koi/dashboard-types";

// ---------------------------------------------------------------------------
// Structural types (loose coupling — no @koi/task-board import)
// ---------------------------------------------------------------------------

/** Minimal shape of a task item from the core TaskBoard. */
export interface TaskItemLike {
  readonly id: string;
  readonly description: string;
  readonly status: "pending" | "assigned" | "completed" | "failed";
  readonly assignedTo?: string | undefined;
  readonly dependencies: readonly string[];
  readonly error?: { readonly message: string } | undefined;
}

/** Minimal shape of a task result from the core TaskBoard. */
export interface TaskResultLike {
  readonly taskId: string;
  readonly output: string;
}

/** Structural interface for a TaskBoard or snapshot provider. */
export interface TaskBoardAdminClientLike {
  readonly all: () => readonly TaskItemLike[];
  readonly completed: () => readonly TaskResultLike[];
}

// ---------------------------------------------------------------------------
// Adapter result
// ---------------------------------------------------------------------------

export interface TaskBoardAdminAdapter {
  readonly views: NonNullable<RuntimeViewDataSource["taskBoard"]>;
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function mapItemStatus(status: TaskItemLike["status"]): TaskBoardNode["status"] {
  switch (status) {
    case "pending":
      return "pending";
    case "assigned":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
  }
}

function mapItemToNode(
  item: TaskItemLike,
  results: ReadonlyMap<string, TaskResultLike>,
): TaskBoardNode {
  const result = results.get(item.id);
  return {
    taskId: item.id,
    label: item.description,
    status: mapItemStatus(item.status),
    ...(item.assignedTo !== undefined ? { assignedTo: item.assignedTo } : {}),
    ...(result !== undefined ? { result: result.output } : {}),
    ...(item.error !== undefined ? { error: item.error.message } : {}),
  };
}

function buildEdges(items: readonly TaskItemLike[]): readonly TaskBoardEdge[] {
  const edges: TaskBoardEdge[] = [];
  for (const item of items) {
    for (const dep of item.dependencies) {
      edges.push({ from: dep, to: item.id });
    }
  }
  return edges;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTaskBoardAdminAdapter(
  client: TaskBoardAdminClientLike,
): TaskBoardAdminAdapter {
  const views: NonNullable<RuntimeViewDataSource["taskBoard"]> = {
    getSnapshot(): DashboardTaskBoardSnapshot {
      const items = client.all();
      const completedResults = client.completed();

      const resultMap = new Map<string, TaskResultLike>();
      for (const r of completedResults) {
        resultMap.set(r.taskId, r);
      }

      const nodes = items.map((item) => mapItemToNode(item, resultMap));
      const edges = buildEdges(items);

      return {
        nodes,
        edges,
        timestamp: Date.now(),
      };
    },
  };

  return { views };
}

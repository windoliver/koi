/**
 * TaskCascade — board-aware helper for coordinator orchestration.
 *
 * Wraps @koi/task-board's detectCycle + topologicalSort into a live-board
 * helper that coordinators use to find ready tasks and detect dependency cycles.
 *
 * findReady()    O(V+E) — tasks whose all dependencies are completed
 * detectCycles() O(V+E) — returns undefined if the dependency graph is a DAG
 */

import type { ManagedTaskBoard, TaskItemId } from "@koi/core";
import { detectCycle, snapshotToItemsMap, topologicalSort } from "@koi/task-board";

export interface TaskCascade {
  /**
   * Returns pending tasks whose all dependencies are in completed status.
   * Uses topological order so earlier tasks appear first.
   * Pure read — never mutates the board.
   */
  readonly findReady: () => readonly TaskItemId[];

  /**
   * Returns cycle paths if the current board's dependency graph has cycles,
   * or undefined if the graph is a valid DAG.
   *
   * Note: @koi/task-board's board.add() already prevents cycles at creation
   * time. This is useful for boards loaded from external storage where that
   * invariant may not have been enforced.
   */
  readonly detectCycles: () => readonly (readonly TaskItemId[])[] | undefined;
}

export function createTaskCascade(board: ManagedTaskBoard): TaskCascade {
  const findReady = (): readonly TaskItemId[] => {
    const items = snapshotToItemsMap(board.snapshot());

    // Use topological order: dependencies appear before their dependents.
    const sorted = topologicalSort(items);

    return sorted.filter((id) => {
      const task = items.get(id);
      if (task === undefined || task.status !== "pending") return false;
      // All dependencies must be completed
      return task.dependencies.every((depId) => {
        const dep = items.get(depId);
        return dep !== undefined && dep.status === "completed";
      });
    });
  };

  const detectCycles = (): readonly (readonly TaskItemId[])[] | undefined => {
    const items = snapshotToItemsMap(board.snapshot());
    const cycles: (readonly TaskItemId[])[] = [];

    // Check each task: if its dependencies would form a cycle, record the path.
    for (const [id, task] of items) {
      const cycle = detectCycle(items, task.dependencies, id);
      if (cycle !== undefined) {
        cycles.push(cycle);
      }
    }

    return cycles.length > 0 ? cycles : undefined;
  };

  return { findReady, detectCycles };
}

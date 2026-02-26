/**
 * Pure DAG functions — cycle detection and topological sort.
 */

import type { TaskItem, TaskItemId } from "@koi/core";

/**
 * Detects whether adding a new node with the given dependencies would
 * create a cycle in the task graph.
 *
 * @returns The cycle path if a cycle is found, or undefined if no cycle.
 */
export function detectCycle(
  items: ReadonlyMap<TaskItemId, TaskItem>,
  newDeps: readonly TaskItemId[],
  newId: TaskItemId,
): readonly TaskItemId[] | undefined {
  // DFS from each dependency of the new node. If any path leads back
  // to newId, we have a cycle: newId → dep → ... → newId.
  const visited = new Set<TaskItemId>();
  const path: TaskItemId[] = [];

  function dfs(current: TaskItemId): readonly TaskItemId[] | undefined {
    if (current === newId) {
      return [...path, current];
    }
    if (visited.has(current)) {
      return undefined;
    }
    visited.add(current);
    path.push(current);
    const item = items.get(current);
    if (item !== undefined) {
      for (const dep of item.dependencies) {
        const cycle = dfs(dep);
        if (cycle !== undefined) {
          return cycle;
        }
      }
    }
    path.pop();
    return undefined;
  }

  for (const dep of newDeps) {
    // Direct self-dependency
    if (dep === newId) {
      return [newId, newId];
    }
    visited.clear();
    path.length = 0;
    const cycle = dfs(dep);
    if (cycle !== undefined) {
      return [newId, ...cycle];
    }
  }

  return undefined;
}

/**
 * Returns task IDs in topological order (dependencies before dependents).
 * Uses Kahn's algorithm. Assumes no cycles in the graph.
 */
export function topologicalSort(items: ReadonlyMap<TaskItemId, TaskItem>): readonly TaskItemId[] {
  // Compute in-degree: for each item, count how many of its deps exist in the map
  const inDegree = new Map<TaskItemId, number>();
  for (const [id, item] of items) {
    // let justified: accumulating count of existing deps
    let count = 0;
    for (const dep of item.dependencies) {
      if (items.has(dep)) {
        count += 1;
      }
    }
    inDegree.set(id, count);
  }

  // Start with nodes that have zero in-degree
  const queue: TaskItemId[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) {
      queue.push(id);
    }
  }

  const result: TaskItemId[] = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    result.push(current);
    // Decrease in-degree of dependents
    for (const [id, item] of items) {
      if (item.dependencies.includes(current)) {
        const newDegree = (inDegree.get(id) ?? 0) - 1;
        inDegree.set(id, newDegree);
        if (newDegree === 0) {
          queue.push(id);
        }
      }
    }
  }

  return result;
}

/**
 * Pure DAG functions — cycle detection and topological sort.
 */

import type { Task, TaskItemId } from "@koi/core";

/**
 * Detects whether adding a new node with the given dependencies would
 * create a cycle in the task graph.
 *
 * @returns The cycle path if a cycle is found, or undefined if no cycle.
 */
export function detectCycle(
  items: ReadonlyMap<TaskItemId, Task>,
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
 * Uses Kahn's algorithm with O(V+E) reverse adjacency map.
 * Assumes no cycles in the graph.
 */
export function topologicalSort(items: ReadonlyMap<TaskItemId, Task>): readonly TaskItemId[] {
  // Build reverse adjacency map: for each node, list its dependents
  const dependents = new Map<TaskItemId, TaskItemId[]>();
  for (const [id] of items) {
    dependents.set(id, []);
  }

  // Compute in-degree and populate reverse adjacency
  const inDegree = new Map<TaskItemId, number>();
  for (const [id, item] of items) {
    // let justified: accumulating count of existing deps
    let count = 0;
    for (const dep of item.dependencies) {
      if (items.has(dep)) {
        count += 1;
        const depList = dependents.get(dep);
        if (depList !== undefined) {
          depList.push(id);
        }
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
    const current = queue.shift();
    if (current === undefined) break;
    result.push(current);
    // Decrease in-degree of dependents via reverse adjacency — O(edges from current)
    const deps = dependents.get(current);
    if (deps !== undefined) {
      for (const dep of deps) {
        const newDegree = (inDegree.get(dep) ?? 0) - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) {
          queue.push(dep);
        }
      }
    }
  }

  return result;
}

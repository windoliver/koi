/**
 * Topological ordering for merge branches.
 *
 * Uses Kahn's algorithm to compute a merge order that respects
 * dependency constraints, and groups branches into independence levels.
 */

import type { KoiError, Result } from "@koi/core";
import type { MergeBranch } from "./types.js";

/**
 * Compute topological merge order via Kahn's algorithm.
 *
 * Returns branch names in an order where every branch appears after
 * all of its dependencies. Returns an error if a cycle is detected.
 */
export function computeMergeOrder(
  branches: readonly MergeBranch[],
): Result<readonly string[], KoiError> {
  if (branches.length === 0) {
    return { ok: true, value: [] };
  }

  const names = new Set(branches.map((b) => b.name));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, readonly string[]>();

  for (const branch of branches) {
    inDegree.set(branch.name, 0);
    adjacency.set(branch.name, []);
  }

  for (const branch of branches) {
    for (const dep of branch.dependsOn) {
      if (!names.has(dep)) continue;
      const current = inDegree.get(branch.name) ?? 0;
      inDegree.set(branch.name, current + 1);
      const existing = adjacency.get(dep) ?? [];
      adjacency.set(dep, [...existing, branch.name]);
    }
  }

  const queue: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      queue.push(name);
    }
  }
  // Sort for deterministic output
  queue.sort();

  const order: string[] = [];

  // Kahn's algorithm: process zero-degree nodes
  while (queue.length > 0) {
    // Safe: loop guard ensures queue is non-empty
    const current = queue.shift() as string;
    order.push(current);

    const dependents = adjacency.get(current) ?? [];
    const newReady: string[] = [];
    for (const dep of dependents) {
      const degree = (inDegree.get(dep) ?? 1) - 1;
      inDegree.set(dep, degree);
      if (degree === 0) {
        newReady.push(dep);
      }
    }
    // Sort newly ready nodes for deterministic ordering
    newReady.sort();
    for (const n of newReady) {
      queue.push(n);
    }
  }

  if (order.length !== branches.length) {
    const remaining = branches.filter((b) => !order.includes(b.name)).map((b) => b.name);
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Cycle detected among branches: ${remaining.join(" -> ")}`,
        retryable: false,
        context: { cycleBranches: remaining },
      },
    };
  }

  return { ok: true, value: order };
}

/**
 * Group branches into independence levels (same BFS depth).
 *
 * Each level contains branches that can be processed after all
 * branches in previous levels have completed. Within a level,
 * branches are independent of each other.
 */
export function computeMergeLevels(
  branches: readonly MergeBranch[],
): Result<readonly (readonly string[])[], KoiError> {
  if (branches.length === 0) {
    return { ok: true, value: [] };
  }

  const names = new Set(branches.map((b) => b.name));
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, readonly string[]>();

  for (const branch of branches) {
    inDegree.set(branch.name, 0);
    adjacency.set(branch.name, []);
  }

  for (const branch of branches) {
    for (const dep of branch.dependsOn) {
      if (!names.has(dep)) continue;
      const current = inDegree.get(branch.name) ?? 0;
      inDegree.set(branch.name, current + 1);
      const existing = adjacency.get(dep) ?? [];
      adjacency.set(dep, [...existing, branch.name]);
    }
  }

  let currentLevel: string[] = [];
  for (const [name, degree] of inDegree) {
    if (degree === 0) {
      currentLevel.push(name);
    }
  }
  currentLevel.sort();

  const levels: (readonly string[])[] = [];
  let processed = 0;

  while (currentLevel.length > 0) {
    levels.push(currentLevel);
    processed += currentLevel.length;

    const nextLevel: string[] = [];
    for (const current of currentLevel) {
      const dependents = adjacency.get(current) ?? [];
      for (const dep of dependents) {
        const degree = (inDegree.get(dep) ?? 1) - 1;
        inDegree.set(dep, degree);
        if (degree === 0) {
          nextLevel.push(dep);
        }
      }
    }
    nextLevel.sort();
    currentLevel = nextLevel;
  }

  if (processed !== branches.length) {
    const remaining = branches.filter((b) => (inDegree.get(b.name) ?? 0) > 0).map((b) => b.name);
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Cycle detected among branches: ${remaining.join(" -> ")}`,
        retryable: false,
        context: { cycleBranches: remaining },
      },
    };
  }

  return { ok: true, value: levels };
}

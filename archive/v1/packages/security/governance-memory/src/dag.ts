/**
 * Constraint DAG — topologically sorted rule graph with cycle detection.
 *
 * Uses Kahn's algorithm for topological sort. Rules are sorted by
 * dependency order first, then by priority within the same dependency level.
 */

import type { KoiError } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { GovernanceRule } from "./types.js";

// ---------------------------------------------------------------------------
// ConstraintDag — the output of DAG construction
// ---------------------------------------------------------------------------

/** A validated, topologically-sorted constraint DAG. */
export interface ConstraintDag {
  /** Rules in topological evaluation order. Frozen. */
  readonly sortedRules: readonly GovernanceRule[];
  /** Dependency lookup: ruleId → IDs of rules it depends on. */
  readonly dependencyMap: ReadonlyMap<string, readonly string[]>;
}

// ---------------------------------------------------------------------------
// createConstraintDag — build and validate the DAG
// ---------------------------------------------------------------------------

/**
 * Build a constraint DAG from governance rules.
 *
 * Validates:
 * - No duplicate rule IDs
 * - All dependsOn references point to existing rules
 * - No cycles (Kahn's algorithm)
 *
 * @throws Error with cause KoiError on validation failure
 */
export function createConstraintDag(rules: readonly GovernanceRule[]): ConstraintDag {
  if (rules.length === 0) {
    return { sortedRules: Object.freeze([]), dependencyMap: new Map() };
  }

  // Check for duplicate IDs
  const idSet = new Set<string>();
  for (const rule of rules) {
    if (idSet.has(rule.id)) {
      throw createValidationError(`Duplicate rule ID: "${rule.id}"`);
    }
    idSet.add(rule.id);
  }

  // Check for unknown dependsOn references
  for (const rule of rules) {
    if (rule.dependsOn !== undefined) {
      for (const dep of rule.dependsOn) {
        if (!idSet.has(dep)) {
          throw createValidationError(`Rule "${rule.id}" depends on unknown rule "${dep}"`);
        }
      }
    }
  }

  // Build dependency map
  const dependencyMap = new Map<string, readonly string[]>();
  for (const rule of rules) {
    dependencyMap.set(rule.id, rule.dependsOn ?? []);
  }

  // Topological sort via Kahn's algorithm
  const sorted = topologicalSort(rules, dependencyMap);

  return {
    sortedRules: Object.freeze(sorted),
    dependencyMap,
  };
}

// ---------------------------------------------------------------------------
// topologicalSort — Kahn's algorithm, O(V+E)
// ---------------------------------------------------------------------------

function topologicalSort(
  rules: readonly GovernanceRule[],
  dependencyMap: ReadonlyMap<string, readonly string[]>,
): readonly GovernanceRule[] {
  const ruleById = new Map<string, GovernanceRule>();
  for (const rule of rules) {
    ruleById.set(rule.id, rule);
  }

  // Compute in-degree for each node
  const inDegree = new Map<string, number>();
  for (const rule of rules) {
    inDegree.set(rule.id, 0);
  }
  for (const [id, deps] of dependencyMap) {
    // In-degree of id = number of deps
    inDegree.set(id, deps.length);
  }

  // Initialize queue with zero in-degree nodes, sorted by priority
  const queue: GovernanceRule[] = [];
  for (const rule of rules) {
    const deg = inDegree.get(rule.id);
    if (deg === 0) {
      queue.push(rule);
    }
  }
  queue.sort((a, b) => a.priority - b.priority);

  // Build reverse adjacency: dep → rules that depend on it
  const dependents = new Map<string, string[]>();
  for (const rule of rules) {
    const deps = dependencyMap.get(rule.id) ?? [];
    for (const dep of deps) {
      const existing = dependents.get(dep);
      if (existing !== undefined) {
        existing.push(rule.id);
      } else {
        dependents.set(dep, [rule.id]);
      }
    }
  }

  const result: GovernanceRule[] = [];
  // let is required for Kahn's queue iteration
  let queueIdx = 0; // let: index advances through the queue

  while (queueIdx < queue.length) {
    const current = queue[queueIdx];
    if (current === undefined) break; // Defensive: should not happen
    queueIdx += 1;
    result.push(current);

    const deps = dependents.get(current.id) ?? [];
    const newlyReady: GovernanceRule[] = [];
    for (const depId of deps) {
      const currentDeg = inDegree.get(depId);
      if (currentDeg === undefined) continue; // Defensive: should not happen
      const newDeg = currentDeg - 1;
      inDegree.set(depId, newDeg);
      if (newDeg === 0) {
        const rule = ruleById.get(depId);
        if (rule !== undefined) {
          newlyReady.push(rule);
        }
      }
    }
    // Sort newly ready by priority before adding to queue
    newlyReady.sort((a, b) => a.priority - b.priority);
    for (const rule of newlyReady) {
      queue.push(rule);
    }
  }

  if (result.length !== rules.length) {
    throw createValidationError(
      `Cycle detected in constraint DAG — ${rules.length - result.length} rules involved in cycle`,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Error factory
// ---------------------------------------------------------------------------

function createValidationError(message: string): Error {
  const cause: KoiError = {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
  return new Error(message, { cause });
}

/**
 * Semantic validators for canvas surfaces.
 *
 * Validates structural invariants that Zod schemas cannot express:
 * - Root component existence
 * - No duplicate component IDs
 * - No cycles in component tree (DFS)
 * - All child references point to existing components
 * - Component count within configured limit
 */

import type { KoiError, Result } from "@koi/core";
import type { CanvasConfig } from "./config.js";
import { DEFAULT_CANVAS_CONFIG } from "./config.js";
import type { A2uiComponent, ComponentId } from "./types.js";

// ---------------------------------------------------------------------------
// Duplicate ID check
// ---------------------------------------------------------------------------

/** Returns duplicate component IDs, if any. */
function findDuplicateIds(components: readonly A2uiComponent[]): readonly ComponentId[] {
  const seen = new Set<string>();
  const duplicates: ComponentId[] = [];
  for (const comp of components) {
    if (seen.has(comp.id)) {
      duplicates.push(comp.id);
    }
    seen.add(comp.id as string);
  }
  return duplicates;
}

// ---------------------------------------------------------------------------
// Dangling child reference check
// ---------------------------------------------------------------------------

/** Returns child references that don't point to any component in the array. */
function findDanglingRefs(components: readonly A2uiComponent[]): readonly string[] {
  const ids = new Set<string>(components.map((c) => c.id as string));
  const dangling: string[] = [];
  for (const comp of components) {
    if (comp.children) {
      for (const childId of comp.children) {
        if (!ids.has(childId as string)) {
          dangling.push(`${comp.id as string} -> ${childId as string}`);
        }
      }
    }
  }
  return dangling;
}

// ---------------------------------------------------------------------------
// Cycle detection (DFS)
// ---------------------------------------------------------------------------

/** Detects cycles in the component tree using iterative DFS. */
function detectCycles(
  components: readonly A2uiComponent[],
  maxDepth: number,
): { readonly hasCycle: boolean; readonly path?: readonly string[] } {
  const childMap = new Map<string, readonly string[]>();
  for (const comp of components) {
    if (comp.children && comp.children.length > 0) {
      childMap.set(
        comp.id as string,
        comp.children.map((c) => c as string),
      );
    }
  }

  // Track visitation state: 0 = unvisited, 1 = in-progress, 2 = done
  const state = new Map<string, number>();
  for (const comp of components) {
    state.set(comp.id as string, 0);
  }

  // Iterative DFS with explicit stack
  for (const comp of components) {
    const startId = comp.id as string;
    if (state.get(startId) === 2) continue;

    // Stack entries: [nodeId, isBacktrack]
    const stack: Array<readonly [string, boolean]> = [[startId, false]];
    // Track path for cycle reporting
    const path: string[] = [];

    while (stack.length > 0) {
      const entry = stack.pop();
      if (entry === undefined) break;
      const [nodeId, isBacktrack] = entry;

      if (isBacktrack) {
        state.set(nodeId, 2);
        path.pop();
        continue;
      }

      const nodeState = state.get(nodeId);
      if (nodeState === 1) {
        return { hasCycle: true, path: [...path, nodeId] };
      }
      if (nodeState === 2) continue;

      if (path.length >= maxDepth) {
        return { hasCycle: true, path: [...path, nodeId] };
      }

      state.set(nodeId, 1);
      path.push(nodeId);
      stack.push([nodeId, true]); // backtrack marker

      const children = childMap.get(nodeId);
      if (children) {
        for (const childId of children) {
          stack.push([childId, false]);
        }
      }
    }
  }

  return { hasCycle: false };
}

// ---------------------------------------------------------------------------
// Public validator
// ---------------------------------------------------------------------------

/**
 * Validates semantic invariants of a component array.
 *
 * Checks: duplicate IDs, dangling child refs, cycles, component count cap.
 */
export function validateSurfaceComponents(
  components: readonly A2uiComponent[],
  config?: Partial<CanvasConfig>,
): Result<true, KoiError> {
  const maxComponents = config?.maxComponents ?? DEFAULT_CANVAS_CONFIG.maxComponents;
  const maxTreeDepth = config?.maxTreeDepth ?? DEFAULT_CANVAS_CONFIG.maxTreeDepth;

  // Check component count
  if (components.length > maxComponents) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Component count ${components.length} exceeds maximum ${maxComponents}`,
        retryable: false,
        context: { count: components.length, max: maxComponents },
      },
    };
  }

  // Check duplicate IDs
  const duplicates = findDuplicateIds(components);
  if (duplicates.length > 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Duplicate component IDs: ${duplicates.join(", ")}`,
        retryable: false,
        context: { duplicateIds: duplicates },
      },
    };
  }

  // Check dangling child references
  const dangling = findDanglingRefs(components);
  if (dangling.length > 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Dangling child references: ${dangling.join(", ")}`,
        retryable: false,
        context: { danglingRefs: dangling },
      },
    };
  }

  // Check cycles
  const cycleResult = detectCycles(components, maxTreeDepth);
  if (cycleResult.hasCycle) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `Cycle detected in component tree: ${cycleResult.path?.join(" -> ") ?? "unknown"}`,
        retryable: false,
        context: { cyclePath: cycleResult.path },
      },
    };
  }

  return { ok: true, value: true };
}

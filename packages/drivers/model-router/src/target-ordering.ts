/**
 * Target ordering strategies for round-robin and weighted routing.
 *
 * Each strategy reorders the target array so the "primary" target is first;
 * remaining targets serve as fallbacks in their reordered position.
 */

import type { FallbackTarget } from "./fallback.js";

/**
 * Reorders targets for a single request. The first element is the primary;
 * remaining elements are fallbacks in priority order.
 */
export type TargetOrderer = (targets: readonly FallbackTarget[]) => readonly FallbackTarget[];

export interface TargetOrdererOptions {
  readonly strategy: "fallback" | "round-robin" | "weighted" | "cascade";
  /** Weight per target ID (0–1). Only used by "weighted" strategy. */
  readonly weights?: ReadonlyMap<string, number>;
  /** Injectable random for deterministic testing. Defaults to Math.random. */
  readonly random?: () => number;
}

/**
 * Creates a TargetOrderer that reorders targets based on the routing strategy.
 *
 * - `"fallback"` / `"cascade"`: identity (declared order)
 * - `"round-robin"`: rotates so `targets[counter % length]` is first, wraps remaining
 * - `"weighted"`: weighted random primary, remaining sorted by descending weight
 */
export function createTargetOrderer(options: TargetOrdererOptions): TargetOrderer {
  const { strategy } = options;

  if (strategy === "fallback" || strategy === "cascade") {
    return (targets) => targets;
  }

  if (strategy === "round-robin") {
    // let: mutable counter — same precedent as metrics counters in router.ts
    let counter = 0;

    return (targets) => {
      if (targets.length <= 1) return targets;

      const index = counter % targets.length;
      counter = (counter + 1) % targets.length;

      // Rotate: [index, index+1, ..., end, 0, 1, ..., index-1]
      return [...targets.slice(index), ...targets.slice(0, index)];
    };
  }

  // strategy === "weighted"
  const weights = options.weights ?? new Map<string, number>();
  const random = options.random ?? Math.random;

  return (targets) => {
    if (targets.length <= 1) return targets;

    // Compute effective weights — default to 1 for missing entries
    const effectiveWeights = targets.map((t) => weights.get(t.id) ?? 1);
    const totalWeight = effectiveWeights.reduce((sum, w) => sum + w, 0);

    // All-zero-weights: return declared order (graceful degradation)
    if (totalWeight === 0) return targets;

    // Weighted random pick for primary target
    const roll = random() * totalWeight;
    // let: accumulator for weighted selection scan
    let cumulative = 0;
    // let: selected index, justified by scan-then-use pattern
    let primaryIndex = targets.length - 1;

    for (let i = 0; i < targets.length; i++) {
      cumulative += effectiveWeights[i] ?? 0;
      if (roll < cumulative) {
        primaryIndex = i;
        break;
      }
    }

    // Remaining targets sorted by descending weight for best-effort fallback
    const remaining = targets
      .filter((_, i) => i !== primaryIndex)
      .map((t) => ({
        target: t,
        weight: weights.get(t.id) ?? 1,
      }))
      .sort((a, b) => b.weight - a.weight)
      .map((entry) => entry.target);

    const primary = targets[primaryIndex];
    if (primary === undefined) return targets;

    return [primary, ...remaining];
  };
}

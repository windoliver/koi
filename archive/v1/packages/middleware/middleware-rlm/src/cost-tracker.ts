/**
 * CostTracker — dollar-denominated budget tracking for RLM REPL loops.
 *
 * Accumulates cost based on a sync cost estimator callback. The consumer
 * provides the estimator (pricing data); the tracker enforces the ceiling.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Sync cost estimator — returns cost in USD for a model call. */
export type CostEstimator = (modelId: string, inputTokens: number, outputTokens: number) => number;

export interface CostTracker {
  /** Record cost for a model call. */
  readonly add: (modelId: string, inputTokens: number, outputTokens: number) => void;
  /** Total accumulated cost in USD. */
  readonly total: () => number;
  /** Remaining budget (maxCostUsd - total). Returns 0 if exceeded. */
  readonly remaining: (maxCostUsd: number) => number;
  /** Whether the budget ceiling has been exceeded. */
  readonly exceeded: (maxCostUsd: number) => boolean;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a CostTracker backed by a sync cost estimator.
 *
 * @param estimator Sync function returning cost in USD for a model call.
 */
export function createCostTracker(estimator: CostEstimator): CostTracker {
  // let: mutable accumulator, encapsulated within closure
  let totalCost = 0;

  return {
    add(modelId: string, inputTokens: number, outputTokens: number): void {
      totalCost += estimator(modelId, inputTokens, outputTokens);
    },

    total(): number {
      return totalCost;
    },

    remaining(maxCostUsd: number): number {
      return Math.max(0, maxCostUsd - totalCost);
    },

    exceeded(maxCostUsd: number): boolean {
      return totalCost >= maxCostUsd;
    },
  };
}

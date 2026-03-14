/**
 * Optimizer middleware — runs brick optimization sweeps on session end.
 *
 * Not on the hot path: sweep runs during onSessionEnd, after all turns
 * are complete. Reports optimization results via describeCapabilities().
 */

import type {
  CapabilityFragment,
  ForgeStore,
  KoiMiddleware,
  SessionContext,
  StoreChangeNotifier,
  TurnContext,
} from "@koi/core";
import type { BrickOptimizer, OptimizationResult } from "./optimizer.js";
import { createBrickOptimizer } from "./optimizer.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the optimizer middleware. */
export interface OptimizerMiddlewareConfig {
  readonly store: ForgeStore;
  /** Minimum invocations before evaluation. Default: 20. */
  readonly minSampleSize?: number | undefined;
  /** Improvement threshold (fraction). Default: 0.1 (10%). */
  readonly improvementThreshold?: number | undefined;
  /** Evaluation window in ms. Default: 604_800_000 (7 days). */
  readonly evaluationWindowMs?: number | undefined;
  /** Minimum policy samples for promotion. Default: 50. */
  readonly minPolicySamples?: number | undefined;
  /** Clock function. Default: Date.now. */
  readonly clock?: (() => number) | undefined;
  /** Called with sweep results. Default: no-op. */
  readonly onSweepComplete?: ((results: readonly OptimizationResult[]) => void) | undefined;
  /** Optional notifier for cross-agent cache invalidation after deprecation. */
  readonly notifier?: StoreChangeNotifier | undefined;
  /**
   * Called when a brick is promoted to policy mode (100% success over minPolicySamples).
   * The caller should register the brick with the policy-cache middleware.
   */
  readonly onPolicyPromotion?: ((brickId: string, result: OptimizationResult) => void) | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a middleware that runs brick optimization on session end.
 *
 * The sweep evaluates all active crystallized bricks and auto-deprecates
 * those that perform worse than their component tools.
 */
export function createOptimizerMiddleware(config: OptimizerMiddlewareConfig): KoiMiddleware {
  const optimizer: BrickOptimizer = createBrickOptimizer({
    store: config.store,
    minSampleSize: config.minSampleSize,
    improvementThreshold: config.improvementThreshold,
    evaluationWindowMs: config.evaluationWindowMs,
    minPolicySamples: config.minPolicySamples,
    clock: config.clock,
    ...(config.notifier !== undefined ? { notifier: config.notifier } : {}),
  });

  const resultsBySession = new Map<string, readonly OptimizationResult[]>();

  return {
    name: "forge-optimizer",
    priority: 990, // Late — runs after all other middleware

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      const results = await optimizer.sweep();
      resultsBySession.set(ctx.sessionId, results);

      // Notify policy promotions so the caller can register with policy-cache
      if (config.onPolicyPromotion !== undefined) {
        for (const result of results) {
          if (result.action === "promote_to_policy") {
            config.onPolicyPromotion(result.brickId, result);
          }
        }
      }

      config.onSweepComplete?.(results);
    },

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const lastResults = resultsBySession.get(ctx.session.sessionId) ?? [];
      if (lastResults.length === 0) return undefined;

      const deprecated = lastResults.filter((r) => r.action === "deprecate").length;
      const kept = lastResults.filter((r) => r.action === "keep").length;
      const insufficient = lastResults.filter((r) => r.action === "insufficient_data").length;

      const parts: string[] = [];
      if (kept > 0) {
        // justified: mutable local array being constructed
        parts.push(`${String(kept)} kept`);
      }
      if (deprecated > 0) {
        parts.push(`${String(deprecated)} deprecated`);
      }
      if (insufficient > 0) {
        parts.push(`${String(insufficient)} insufficient data`);
      }

      return {
        label: "forge-optimizer",
        description: `Brick optimization: ${parts.join(", ")}`,
      };
    },
  };
}

/**
 * Main factory for the quality-gate meta-package.
 *
 * Creates and composes output-verifier, feedback-loop, and (optionally)
 * budget middleware into a coherent bundle with delegating handles.
 *
 * Middleware priority ordering:
 *   output-verifier (385) → feedback-loop (450) → budget (999)
 */

import type { KoiMiddleware } from "@koi/core";
import { createFeedbackLoopMiddleware } from "@koi/middleware-feedback-loop";
import { createOutputVerifierMiddleware } from "@koi/middleware-output-verifier";
import { createBudgetMiddleware } from "./budget-middleware.js";
import { resolveQualityGateConfig } from "./config-resolution.js";
import type { QualityGateBundle, QualityGateConfig } from "./types.js";

/** Creates a quality-gate bundle from the given configuration. */
export function createQualityGate(config: QualityGateConfig): QualityGateBundle {
  const resolved = resolveQualityGateConfig(config);

  // Create L2 handles (skip when disabled)
  const verifierHandle =
    resolved.verifier !== undefined ? createOutputVerifierMiddleware(resolved.verifier) : undefined;

  const feedbackLoopHandle =
    resolved.feedbackLoop !== undefined
      ? createFeedbackLoopMiddleware(resolved.feedbackLoop)
      : undefined;

  // Budget middleware only when maxTotalModelCalls is set
  const budgetMw =
    resolved.maxTotalModelCalls !== undefined
      ? createBudgetMiddleware(resolved.maxTotalModelCalls)
      : undefined;

  // Assemble middleware array in priority order (filter undefined)
  const candidates: ReadonlyArray<KoiMiddleware | undefined> = [
    verifierHandle?.middleware, // priority 385
    feedbackLoopHandle?.middleware, // priority 450
    budgetMw, // priority 999
  ];
  const middleware = candidates.filter((mw): mw is KoiMiddleware => mw !== undefined);

  return {
    middleware,
    verifier: verifierHandle,
    feedbackLoop: feedbackLoopHandle,
    config: {
      preset: resolved.preset,
      middlewareCount: middleware.length,
      verifierEnabled: verifierHandle !== undefined,
      feedbackLoopEnabled: feedbackLoopHandle !== undefined,
      budgetEnabled: budgetMw !== undefined,
    },
    reset: (): void => {
      verifierHandle?.reset();
      // feedback-loop has no reset — health state persists per session
    },
  };
}

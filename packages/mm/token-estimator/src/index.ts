/**
 * @koi/token-estimator — Shared heuristic token estimation (L0u).
 *
 * Provides a configurable factory, a pre-built singleton, and a bare
 * convenience function for the "4 chars ≈ 1 token" heuristic.
 *
 * L0u package — depends on @koi/core only.
 */

export type { HeuristicEstimatorConfig } from "./estimator.js";
export {
  CHARS_PER_TOKEN,
  createHeuristicEstimator,
  estimateTokens,
  HEURISTIC_ESTIMATOR,
} from "./estimator.js";

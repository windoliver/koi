/**
 * Heuristic token estimator — delegates to @koi/token-estimator.
 *
 * Re-exports the canonical singleton as `heuristicTokenEstimator`
 * for backward compatibility with internal consumers.
 */

export { HEURISTIC_ESTIMATOR as heuristicTokenEstimator } from "@koi/token-estimator";

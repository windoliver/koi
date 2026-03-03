/**
 * @koi/forge-demand — Demand-triggered forge detection middleware.
 *
 * Monitors tool calls and model responses for capability gaps, repeated
 * failures, and performance degradation. Emits ForgeDemandSignal when
 * environmental pressure demands new tool creation.
 *
 * Layer 2: depends on @koi/core + @koi/errors + @koi/validation only.
 */

export type { DemandContext } from "./confidence.js";
export { computeDemandConfidence, DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";
export {
  createDefaultForgeDemandConfig,
  DEFAULT_FORGE_DEMAND_CONFIG,
  validateForgeDemandConfig,
} from "./config.js";
export { createForgeDemandDetector } from "./demand-detector.js";
export {
  DEFAULT_CAPABILITY_GAP_PATTERNS,
  detectCapabilityGap,
  detectLatencyDegradation,
  detectRepeatedFailure,
} from "./heuristics.js";
export type {
  ConfidenceWeights,
  FeedbackLoopHealthHandle,
  ForgeDemandConfig,
  ForgeDemandHandle,
  HeuristicThresholds,
} from "./types.js";

/**
 * @koi/forge-demand — demand-triggered forge detection middleware.
 *
 * Detects capability gaps, repeated tool failures, latency degradation, and
 * user corrections; emits `ForgeDemandSignal` for the auto-forge pipeline
 * to consume. Layer 2: depends on `@koi/core` + L0u utilities only.
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
  DEFAULT_USER_CORRECTION_PATTERNS,
  detectCapabilityGap,
  detectLatencyDegradation,
  detectRepeatedFailure,
  detectUserCorrection,
} from "./heuristics.js";
export type {
  ConfidenceWeights,
  FeedbackLoopHealthHandle,
  ForgeDemandConfig,
  ForgeDemandHandle,
  HeuristicThresholds,
} from "./types.js";

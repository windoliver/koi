/**
 * @koi/collusion-detector — Cross-agent collusion detection.
 *
 * Provides 4 deterministic signal detectors (Institutional AI pattern):
 * 1. Synchronous Move — agents shifting behavior in lockstep
 * 2. Variance Collapse — cross-agent behavior becoming uniform
 * 3. Concentration — resource access dominated by few agents (HHI)
 * 4. Specialization — agents dividing the market
 */

export {
  DEFAULT_COLLUSION_THRESHOLDS,
  resolveThresholds,
  resolveWindowSize,
  validateCollusionDetectorConfig,
} from "./config.js";
export {
  computeCV,
  computeHHI,
  computeMean,
  computeStddev,
  detectAll,
  detectConcentration,
  detectSpecialization,
  detectSyncMove,
  detectVarianceCollapse,
} from "./detector.js";
export type {
  AgentObservation,
  CollusionDetectorConfig,
  CollusionSignal,
  CollusionSignalKind,
  CollusionThresholds,
} from "./types.js";
export type { ObservationWindow } from "./window.js";
export { createObservationWindow } from "./window.js";

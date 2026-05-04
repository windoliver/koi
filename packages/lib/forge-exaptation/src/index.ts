/**
 * @koi/forge-exaptation — Purpose-drift detection for forge artifacts.
 *
 * Issue #1351 — minimal v2 detector. Pure functions over usage observations:
 * no middleware, no state, no I/O. Upstream observers feed `UsagePurposeObservation`s
 * and consume `DriftReport` + `ExaptationSuggestion` results.
 *
 * L2: depends on `@koi/core` (L0) and `@koi/forge-types` (L0u) only.
 */

export type {
  DriftReport,
  ExaptationSuggestion,
  ExaptationThresholds,
} from "./detector.js";
export {
  DEFAULT_EXAPTATION_THRESHOLDS,
  detectDrift,
  suggestAction,
} from "./detector.js";
export { computeJaccardDistance, tokenize } from "./divergence.js";

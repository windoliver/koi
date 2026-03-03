/**
 * @koi/forge-exaptation — Exaptation (purpose drift) detection middleware.
 *
 * Monitors tool usage context to detect when bricks are repurposed
 * beyond their original design. Emits ExaptationSignal when multiple
 * agents use a tool for purposes that diverge from its stated description.
 *
 * Layer 2: depends on @koi/core + @koi/errors + @koi/validation only.
 */

export { computeExaptationConfidence } from "./confidence.js";
export {
  createDefaultExaptationConfig,
  DEFAULT_EXAPTATION_CONFIG,
  validateExaptationConfig,
} from "./config.js";
export { computeJaccardDistance, tokenize, truncateToWords } from "./divergence.js";
export { createExaptationDetector } from "./exaptation-detector.js";
export { detectPurposeDrift } from "./heuristics.js";
export type {
  ExaptationConfig,
  ExaptationHandle,
  ExaptationThresholds,
} from "./types.js";

/**
 * @koi/middleware-personalization — Dual-channel preference learning (Layer 2)
 *
 * Pre-action: detects ambiguity, injects clarification directives.
 * Post-action: detects corrections, stores preference updates.
 * Depends on @koi/core + L0u only.
 */

export type { AmbiguityAssessment, AmbiguityClassifier } from "./ambiguity-classifier.js";
export { createDefaultAmbiguityClassifier } from "./ambiguity-classifier.js";
export type {
  PersonalizationConfig,
  PostActionConfig,
  PreActionConfig,
  ResolvedPersonalizationConfig,
} from "./config.js";
export { validatePersonalizationConfig } from "./config.js";
export type { CorrectionAssessment, CorrectionDetector } from "./correction-detector.js";
export { createDefaultCorrectionDetector } from "./correction-detector.js";
export { createPersonalizationMiddleware } from "./personalization.js";
export type { PreferenceCache } from "./preference-cache.js";
export { createPreferenceCache } from "./preference-cache.js";

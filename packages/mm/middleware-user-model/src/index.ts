/**
 * @koi/middleware-user-model — Unified user modeling middleware (Layer 2)
 *
 * Combines preference learning (pre-action + post-action), drift detection,
 * and sensor enrichment into a single middleware with coherent signal processing.
 * Depends on @koi/core + L0u only.
 */

export type { AmbiguityAssessment, AmbiguityClassifier } from "./ambiguity-classifier.js";
export { createDefaultAmbiguityClassifier } from "./ambiguity-classifier.js";
export type { CascadedDriftOptions } from "./cascaded-drift.js";
export { createCascadedDriftDetector } from "./cascaded-drift.js";
export { validateUserModelConfig } from "./config.js";
export type { CorrectionAssessment, CorrectionDetector } from "./correction-detector.js";
export { createDefaultCorrectionDetector } from "./correction-detector.js";
export type {
  KeywordDriftOptions,
  PreferenceDriftDetector,
  PreferenceDriftSignal,
} from "./keyword-drift.js";
export { createKeywordDriftDetector } from "./keyword-drift.js";
export { createLlmDriftDetector } from "./llm-drift.js";
export type { LlmClassifier, SalienceGate } from "./llm-salience.js";
export { createLlmSalienceGate } from "./llm-salience.js";
export type { SnapshotCache } from "./snapshot-cache.js";
export { createSnapshotCache } from "./snapshot-cache.js";
export type { ResolvedUserModelConfig, UserModelConfig } from "./types.js";
export { createUserModelMiddleware } from "./user-model-middleware.js";

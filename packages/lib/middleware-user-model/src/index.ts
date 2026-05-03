/**
 * @koi/middleware-user-model — unified pre/post-action + sensor user model.
 */

export type { AmbiguityResult } from "./ambiguity-classifier.js";
export { classifyAmbiguity } from "./ambiguity-classifier.js";
export { createCascadedDriftDetector } from "./cascaded-drift.js";
export { resolveUserModelDefaults, validateUserModelConfig } from "./config.js";
export type { InjectorBudgets } from "./context-injector.js";
export { buildContextMessage, formatUserContext } from "./context-injector.js";
export { isCorrection } from "./correction-detector.js";
export { createKeywordDriftDetector } from "./keyword-drift.js";
export { createLlmDriftDetector } from "./llm-drift.js";
export { createLlmSalienceGate } from "./llm-salience.js";
export { readSignalSources } from "./signal-reader.js";
export type { SnapshotBuilder, SnapshotCache } from "./snapshot-cache.js";
export { createSnapshotCache } from "./snapshot-cache.js";
export { extractLastUserText, extractText } from "./text-extractor.js";
export type {
  DriftDecision,
  LlmClassifier,
  PreferenceDriftDetector,
  ResolvedUserModelConfig,
  SalienceGate,
  UserModelConfig,
} from "./types.js";
export {
  DEFAULT_MAX_META_TOKENS,
  DEFAULT_MAX_PREFERENCE_TOKENS,
  DEFAULT_MAX_SENSOR_TOKENS,
  DEFAULT_PREFERENCE_CATEGORY,
  DEFAULT_PREFERENCE_NAMESPACE,
  DEFAULT_PRIORITY,
  DEFAULT_RECALL_LIMIT,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_SIGNAL_TIMEOUT_MS,
} from "./types.js";
export { createUserModelMiddleware } from "./user-model-middleware.js";

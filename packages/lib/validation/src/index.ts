/**
 * @koi/validation — Shared validation utilities (Layer 2)
 *
 * Provides zodToKoiError and validateWith for consistent config validation,
 * plus validateBrickArtifact for storage backend deserialization.
 * Depends on @koi/core (for KoiError/Result) and zod.
 */

export { applyBrickUpdate } from "./apply-brick-update.js";
export {
  type RequiresViolation,
  type RequiresViolationKind,
  validateBrickRequires,
  validateCredentialRequires,
} from "./brick-requires.js";
export { validateBrickArtifact } from "./brick-validation.js";
export {
  compactEntries,
  computeMemoryPriority,
  deduplicateEntries,
  pruneStaleEntries,
  selectEntriesWithinBudget,
} from "./collective-memory.js";
export {
  checkSchemaCompatibility,
  type PipelineValidation,
  type SchemaCompatibility,
  validatePipeline,
} from "./composition-validation.js";
export {
  credentialKindSchema,
  credentialRequirementSchema,
  credentialRequiresSchema,
} from "./credential-schema.js";
export { computeDrift } from "./drift-scoring.js";
export {
  computeBrickFitness,
  DEFAULT_DECAY_THRESHOLDS,
  DEFAULT_FITNESS_SCORING_CONFIG,
  type DecayThresholds,
  evaluateTrustDecay,
  type FitnessScoringConfig,
} from "./fitness-scoring.js";
export {
  computePercentile,
  createLatencySampler,
  mergeSamplers,
  recordLatency,
} from "./latency-sampler.js";
export { findClosestMatch, levenshteinDistance } from "./levenshtein.js";
export { computeMutationPressure } from "./mutation-pressure.js";
export { matchesBrickQuery } from "./query-match.js";
export { SEVERITY_ORDER, type Severity, severityAtOrAbove } from "./severity.js";
export { type SortBricksOptions, sortBricks } from "./sort-bricks.js";
export { createMemoryStoreChangeNotifier } from "./store-notifier.js";
export {
  computeEffectiveTrailStrength,
  computeTrailReinforcement,
  isTrailEvaporated,
} from "./trail-strength.js";
export { validateWith, zodToKoiError } from "./validation.js";

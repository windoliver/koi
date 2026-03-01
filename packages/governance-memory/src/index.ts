/**
 * @koi/governance-memory — In-memory GovernanceBackend implementation.
 *
 * Provides Cedar-inspired constraint DAG evaluation, anomaly bridge integration,
 * adaptive thresholds, and bounded compliance/violation storage.
 */

export type { AdaptiveThreshold } from "./adaptive-threshold.js";
export { adjustThreshold, createAdaptiveThreshold } from "./adaptive-threshold.js";
export { validateGovernanceMemoryConfig } from "./config.js";
export type { ConstraintDag } from "./dag.js";
export { createConstraintDag } from "./dag.js";
export type { MemoryEvaluator } from "./evaluator.js";
export { createMemoryEvaluator } from "./evaluator.js";
export { createGovernanceMemoryBackend } from "./governance-memory.js";
export type {
  AdaptiveThresholdConfig,
  AnomalySignalLike,
  EvaluationContext,
  GovernanceMemoryConfig,
  GovernanceRule,
} from "./types.js";

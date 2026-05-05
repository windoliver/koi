/**
 * @koi/forge-optimizer — advisory artifact-optimization helpers (L2).
 * Issue #1350.
 */

export type { LifecycleTransitionResult } from "./lifecycle.js";
export { validateGraphTransition, validateStoreTransition } from "./lifecycle.js";

export type { PerformanceScoreOptions } from "./performance.js";
export { computePerformanceScore } from "./performance.js";

export type { RetirementPolicy, RetirementSuggestion } from "./retirement.js";
export { suggestRetirement } from "./retirement.js";

export type {
  MergeResult,
  MergeSkipped,
  MergeSuggestion,
  SimplifySuggestion,
} from "./suggestions.js";
export { suggestMerge, suggestSimplify } from "./suggestions.js";

export type {
  FitnessIntegrityIssue,
  FitnessIntegrityListener,
  UsageEvent,
} from "./usage.js";
export { detectFitnessIntegrity, recordUsage } from "./usage.js";

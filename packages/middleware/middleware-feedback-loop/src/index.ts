/**
 * @koi/middleware-feedback-loop — Local validation, retry with error feedback, and quality gates.
 *
 * Validates model outputs and tool inputs/outputs. On model validation failure,
 * injects error context back into the request and retries. Quality gates halt
 * the pipeline on failure without retry. Layer 2: depends on @koi/core only.
 */

export type { FeedbackLoopConfig, ForgeHealthConfig } from "./config.js";
export { validateFeedbackLoopConfig } from "./config.js";
export type { FeedbackLoopHandle } from "./feedback-loop.js";
export { createFeedbackLoopMiddleware } from "./feedback-loop.js";
export type { FlushDeltas } from "./fitness-flush.js";
export { computeMergedFitness, shouldFlush } from "./fitness-flush.js";
export type { ForgeRepairConfig } from "./forge-repair.js";
export { createForgeRepairStrategy } from "./forge-repair.js";
export { defaultRepairStrategy, formatErrors } from "./repair.js";
export type { ToolFlushState, ToolHealthTracker } from "./tool-health.js";
export { createToolHealthTracker } from "./tool-health.js";
export type {
  DiscoveryMissRecord,
  ForgeToolErrorFeedback,
  RepairStrategy,
  RetryConfig,
  ToolFailureRecord,
  ToolHealthMetrics,
  ToolHealthSnapshot,
  ToolHealthState,
  TrustDemotionReason,
  ValidationError,
  ValidationResult,
  Validator,
} from "./types.js";

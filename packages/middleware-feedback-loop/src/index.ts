/**
 * @koi/middleware-feedback-loop — Local validation, retry with error feedback, and quality gates.
 *
 * Validates model outputs and tool inputs/outputs. On model validation failure,
 * injects error context back into the request and retries. Quality gates halt
 * the pipeline on failure without retry. Layer 2: depends on @koi/core only.
 */

export type { FeedbackLoopConfig } from "./config.js";
export { validateConfig } from "./config.js";
export { createFeedbackLoopMiddleware } from "./feedback-loop.js";
export { defaultRepairStrategy, formatErrors } from "./repair.js";
export type {
  RepairStrategy,
  RetryConfig,
  ValidationError,
  ValidationResult,
  Validator,
} from "./types.js";

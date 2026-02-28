/**
 * @koi/forge-optimizer — Statistical brick optimization (L2).
 * @packageDocumentation
 *
 * Evaluates crystallized composite bricks against their component tools
 * using fitness metrics (success rate, latency, recency). Bricks that
 * perform worse than their components are auto-deprecated.
 *
 * Depends on @koi/core only.
 */

export type {
  BrickOptimizer,
  OptimizationConfig,
  OptimizationResult,
} from "./optimizer.js";
export { computeFitnessScore, createBrickOptimizer } from "./optimizer.js";
export type { OptimizerMiddlewareConfig } from "./optimizer-middleware.js";
export { createOptimizerMiddleware } from "./optimizer-middleware.js";

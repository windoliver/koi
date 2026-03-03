/**
 * @koi/middleware-pay — Token budget enforcement (Layer 2)
 *
 * Tracks token costs per model/tool call, enforces budget limits,
 * and alerts on threshold crossings.
 * Depends on @koi/core only.
 */

// Re-export L0 breakdown types for convenience
export type {
  CostBreakdown,
  ModelCostBreakdown,
  ToolCostBreakdown,
} from "@koi/core/cost-tracker";
export type { PayMiddlewareConfig, UsageInfo } from "./config.js";
export { validatePayConfig } from "./config.js";
export { descriptor } from "./descriptor.js";
export { createPayMiddleware } from "./pay.js";
export type { BudgetTracker, CostCalculator } from "./tracker.js";
export {
  createDefaultCostCalculator,
  createInMemoryBudgetTracker,
  createInMemoryPayLedger,
} from "./tracker.js";

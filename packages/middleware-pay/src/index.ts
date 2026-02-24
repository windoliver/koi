/**
 * @koi/middleware-pay — Token budget enforcement (Layer 2)
 *
 * Tracks token costs per model/tool call, enforces budget limits,
 * and alerts on threshold crossings.
 * Depends on @koi/core only.
 */

export type { PayMiddlewareConfig, UsageInfo } from "./config.js";
export { validatePayConfig } from "./config.js";
export { createPayMiddleware } from "./pay.js";
export type { BudgetTracker, CostCalculator, CostEntry } from "./tracker.js";
export {
  createDefaultCostCalculator,
  createInMemoryBudgetTracker,
} from "./tracker.js";

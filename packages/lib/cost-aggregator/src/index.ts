/**
 * @koi/cost-aggregator — Real-time cost aggregation with per-model/tool/agent/provider
 * breakdowns and configurable budget thresholds.
 *
 * Spec: docs/L2/cost-dashboard.md
 *
 * Implements the L0 BudgetTracker contract with:
 * - O(1) pre-aggregated breakdown queries
 * - Per-agent and per-provider dimensions
 * - Bounded ring buffer for raw entry audit trail
 * - Tiered pricing (cached tokens, reasoning tokens)
 * - Exactly-once soft warning thresholds
 * - JSON export for external dashboard integration
 */

// --- Calculator ---
export type { CostCalculatorConfig } from "./calculator.js";
export { createCostCalculator } from "./calculator.js";

// --- Pricing ---
export type { ModelPricing } from "./pricing.js";
export { DEFAULT_PRICING, resolvePricing } from "./pricing.js";

// --- Ring buffer ---
export type { RingBuffer } from "./ring-buffer.js";
export { createRingBuffer, DEFAULT_CAPACITY } from "./ring-buffer.js";

// --- Thresholds ---
export type { ThresholdAlert, ThresholdConfig, ThresholdTracker } from "./thresholds.js";
export { createThresholdTracker, DEFAULT_THRESHOLDS } from "./thresholds.js";

// --- Tracker (main aggregator) ---
export type { CostAggregator, CostAggregatorConfig } from "./tracker.js";
export { createCostAggregator } from "./tracker.js";

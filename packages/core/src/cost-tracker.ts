/**
 * Cost tracking contracts — per-session, per-tool, per-model cost transparency.
 *
 * Pure types only. No runtime code, no imports from other packages.
 * Defines the canonical cost tracking interfaces shared across L0, L1, and L2.
 */

/** A single cost event recorded during a model call. */
export interface CostEntry {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly costUsd: number;
  readonly timestamp: number;
  /** Optional tool attribution — set when the model call was on behalf of a tool. */
  readonly toolName?: string | undefined;
}

/** Aggregated cost for a single model within a session. */
export interface ModelCostBreakdown {
  readonly model: string;
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly callCount: number;
}

/** Aggregated cost for a single tool within a session. */
export interface ToolCostBreakdown {
  readonly toolName: string;
  readonly totalCostUsd: number;
  readonly callCount: number;
}

/** Full cost breakdown for a session — total + per-model + per-tool. */
export interface CostBreakdown {
  readonly totalCostUsd: number;
  readonly byModel: readonly ModelCostBreakdown[];
  readonly byTool: readonly ToolCostBreakdown[];
}

/**
 * Calculates the USD cost of a model call from token counts.
 *
 * Implementations may use static rate tables or dynamic pricing APIs.
 */
export interface CostCalculator {
  readonly calculate: (model: string, inputTokens: number, outputTokens: number) => number;
}

/**
 * Session-scoped budget tracker with breakdown queries.
 *
 * All methods return `T | Promise<T>` so implementations can be
 * sync (in-memory) or async (network/database) without interface changes.
 */
export interface BudgetTracker {
  readonly record: (sessionId: string, entry: CostEntry) => void | Promise<void>;
  readonly totalSpend: (sessionId: string) => number | Promise<number>;
  readonly remaining: (sessionId: string, budget: number) => number | Promise<number>;
  readonly breakdown: (sessionId: string) => CostBreakdown | Promise<CostBreakdown>;
}

/** Enriched usage information passed to onUsage callbacks. */
export interface UsageInfo {
  readonly entry: CostEntry;
  readonly totalSpent: number;
  readonly remaining: number;
  readonly breakdown: CostBreakdown;
}

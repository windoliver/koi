/**
 * Cost tracking contracts — per-session, per-tool, per-model cost transparency.
 *
 * Defines the canonical cost tracking interfaces shared across L0, L1, and L2.
 * Types are interface-only; formatting helpers are pure functions (L0 exception).
 */

// ---------------------------------------------------------------------------
// Token breakdown — detailed token classification for tiered pricing
// ---------------------------------------------------------------------------

/**
 * Detailed token breakdown for accurate cost calculation.
 *
 * Modern LLM providers use tiered pricing:
 * - Cached input tokens: Anthropic 10% of base, OpenAI 50%
 * - Cache creation tokens: Anthropic 1.25x (5-min) or 2x (1-hr extended)
 * - Reasoning/thinking tokens: billed as output, invisible to user
 *
 * All fields optional — callers provide what the provider reports.
 */
export interface CostTokenBreakdown {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Tokens read from provider cache (discounted rate). */
  readonly cachedInputTokens?: number | undefined;
  /** Tokens written to provider cache (premium rate). */
  readonly cacheCreationTokens?: number | undefined;
  /** Reasoning/thinking tokens — billed as output but not shown to user. */
  readonly reasoningTokens?: number | undefined;
}

// ---------------------------------------------------------------------------
// Cost entry — single cost event
// ---------------------------------------------------------------------------

/** A single cost event recorded during a model call. */
export interface CostEntry {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly model: string;
  readonly costUsd: number;
  readonly timestamp: number;
  /** Optional tool attribution — set when the model call was on behalf of a tool. */
  readonly toolName?: string | undefined;
  /** Provider identifier for per-provider aggregation (e.g. "openai", "anthropic"). */
  readonly provider?: string | undefined;
  /** Agent identifier for per-agent aggregation in multi-agent sessions. */
  readonly agentId?: string | undefined;
  /** Detailed token breakdown for tiered pricing — present when provider reports it. */
  readonly tokenBreakdown?: CostTokenBreakdown | undefined;
}

// ---------------------------------------------------------------------------
// Aggregated breakdowns
// ---------------------------------------------------------------------------

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

/** Aggregated cost for a single agent within a session. */
export interface AgentCostBreakdown {
  readonly agentId: string;
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly callCount: number;
}

/** Aggregated cost for a single provider within a session. */
export interface ProviderCostBreakdown {
  readonly provider: string;
  readonly totalCostUsd: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly callCount: number;
}

/** Full cost breakdown for a session — total + per-model + per-tool + per-agent + per-provider. */
export interface CostBreakdown {
  readonly totalCostUsd: number;
  readonly byModel: readonly ModelCostBreakdown[];
  readonly byTool: readonly ToolCostBreakdown[];
  /** Per-agent breakdown — present when entries include agentId. */
  readonly byAgent?: readonly AgentCostBreakdown[] | undefined;
  /** Per-provider breakdown — present when entries include provider. */
  readonly byProvider?: readonly ProviderCostBreakdown[] | undefined;
}

// ---------------------------------------------------------------------------
// Cost calculator
// ---------------------------------------------------------------------------

/**
 * Calculates the USD cost of a model call from token counts.
 *
 * Implementations may use static rate tables or dynamic pricing APIs.
 */
export interface CostCalculator {
  /** Simple calculation from flat input/output token counts. */
  readonly calculate: (model: string, inputTokens: number, outputTokens: number) => number;
  /**
   * Detailed calculation with tiered pricing (cached tokens, reasoning tokens, etc.).
   * Falls back to `calculate()` when not implemented.
   */
  readonly calculateDetailed?: (model: string, breakdown: CostTokenBreakdown) => number;
}

// ---------------------------------------------------------------------------
// Budget tracker
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Formatting helpers — pure functions for cost/token display
// ---------------------------------------------------------------------------

/** Format a token count for human display (e.g. 1500 → "1.5k", 2500000 → "2.5M"). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/**
 * Format a USD cost for human display.
 *
 * - `null` → em-dash (no data)
 * - < $0.01 → 4 decimal places (e.g. "$0.0050")
 * - ≥ $0.01 → 2 decimal places (e.g. "$1.23")
 */
export function formatCost(costUsd: number | null): string {
  if (costUsd === null) return "—";
  if (costUsd < 0.01) return `$${costUsd.toFixed(4)}`;
  return `$${costUsd.toFixed(2)}`;
}

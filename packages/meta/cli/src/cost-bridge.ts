/**
 * Cost bridge — wires @koi/cost-aggregator into the TUI event lifecycle.
 *
 * Creates a CostAggregator + CostCalculator and provides:
 *   - recordEngineDone(): feed cost data from engine "done" events
 *   - dispatchBreakdown(): push current breakdown to the TUI store
 *
 * The host (tui-command.ts) calls recordEngineDone after each drainEngineStream
 * and dispatchBreakdown to push the updated state to the TUI's CostDashboardView.
 *
 * 200ms debounce (Decision 14A) is handled via a trailing timer so multiple
 * rapid engine completions don't flood the TUI with re-renders.
 */

import type { CostBreakdown, CostEntry } from "@koi/core/cost-tracker";
import {
  type CostAggregator,
  type CostExportPayload,
  createCostAggregator,
  createCostCalculator,
  createThresholdTracker,
  createTokenRateTracker,
  exportCostJson,
  fetchModelPricing,
  type ThresholdAlert,
  type TokenRateTracker,
} from "@koi/cost-aggregator";
import type { TuiStore } from "@koi/tui";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface CostBridgeConfig {
  /** TUI store to dispatch set_cost_breakdown actions. */
  readonly store: TuiStore;
  /** Session ID for cost tracking. */
  readonly sessionId: string;
  /** Model name for cost calculation (from session info). */
  readonly modelName: string;
  /** Provider name for per-provider aggregation. */
  readonly provider: string;
  /** Optional budget limit in USD. When set, soft warnings fire at 50/75/90%. */
  readonly budgetUsd?: number | undefined;
  /** Called when a budget threshold is crossed. */
  readonly onBudgetAlert?: (alert: ThresholdAlert) => void;
}

export interface CostBridge {
  /**
   * Feed cost data from an engine "done" event's metrics.
   *
   * `metrics.modelName` lets the caller attribute this recording to the
   * model that actually served the turn — snapshot at turn-start, not
   * mutable bridge state at turn-end. If omitted, the bridge's current
   * `modelName` is used (backwards-compatible; races with mid-turn switches).
   *
   * `metrics.pricingModel` decouples display attribution from pricing
   * lookup. Use it when the display label is a synthetic bucket (e.g.
   * `"<fallback-chain>"`) that has no entry in the pricing table — the
   * bridge will estimate `costUsd` from `pricingModel` while still
   * recording the entry under `modelName`. Omit to use `modelName` for
   * both.
   */
  readonly recordEngineDone: (metrics: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd?: number | undefined;
    readonly modelName?: string | undefined;
    readonly pricingModel?: string | undefined;
  }) => void;
  /** Force-push the current breakdown to the TUI store (skips debounce). */
  readonly flushBreakdown: () => void;
  /** Access the underlying aggregator. */
  readonly aggregator: CostAggregator;
  /** Access the token rate tracker. */
  readonly tokenRate: TokenRateTracker;
  /** Export current cost state as JSON (for external dashboards). */
  readonly exportJson: () => CostExportPayload;
  /** Update session context (e.g. after session reset). */
  readonly setSession: (sessionId: string, modelName: string, provider: string) => void;
  /** Update only the active model name (mid-session switch). */
  readonly setModelName: (modelName: string) => void;
  /** Stop the debounce timer. Call on shutdown. */
  readonly dispose: () => void;
}

/** Debounce interval for TUI breakdown pushes (Decision 14A). */
const DEBOUNCE_MS = 200;

/**
 * Create a cost bridge that wires the aggregator into the TUI lifecycle.
 *
 * Fetches live pricing from models.dev at startup (non-blocking, 5s timeout).
 * Falls back to bundled pricing table if offline.
 */
export async function createCostBridge(config: CostBridgeConfig): Promise<CostBridge> {
  // Fetch live pricing from models.dev (disk cached, 5-min TTL)
  const livePricing = await fetchModelPricing();
  const calculator = createCostCalculator({ livePricing });

  const thresholdTracker =
    config.budgetUsd !== undefined
      ? createThresholdTracker({
          budget: config.budgetUsd,
          onAlert: config.onBudgetAlert ?? (() => {}),
        })
      : undefined;

  const aggregator = createCostAggregator({ thresholdTracker });
  const tokenRate = createTokenRateTracker();

  // Mutable session context — updated on session reset
  // let: justified — mutated by setSession()
  let sessionId = config.sessionId;
  let modelName = config.modelName;
  let provider = config.provider;

  // Debounced TUI dispatch
  // let: justified — timer handle for debounce
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function pushBreakdown(): void {
    const breakdown: CostBreakdown = aggregator.breakdown(sessionId);
    if (breakdown.totalCostUsd > 0) {
      config.store.dispatch({
        kind: "set_cost_breakdown",
        breakdown,
        tokenRate: {
          inputPerSecond: tokenRate.inputPerSecond(),
          outputPerSecond: tokenRate.outputPerSecond(),
        },
      });
    }
  }

  function schedulePush(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      pushBreakdown();
    }, DEBOUNCE_MS);
  }

  return {
    recordEngineDone(metrics): void {
      // Prefer the caller-provided turn-snapshot model name. Without it we
      // fall back to the bridge's current value, which races with mid-turn
      // `setModelName()` calls from the picker.
      const effectiveModel = metrics.modelName ?? modelName;
      // Decouple display attribution from pricing lookup: if the caller
      // passes a synthetic bucket (e.g. `"<fallback-chain>"`) as
      // `modelName`, the pricing table won't have an entry for it and the
      // calculator would return 0. Use `pricingModel` for the price
      // lookup when provided so real spend is still estimated even when
      // the display bucket is synthetic.
      const pricingLookupModel = metrics.pricingModel ?? effectiveModel;
      // Compute cost if not provided by the engine
      const costUsd =
        metrics.costUsd ??
        calculator.calculateDetailed?.(pricingLookupModel, {
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
        }) ??
        calculator.calculate(pricingLookupModel, metrics.inputTokens, metrics.outputTokens);

      const entry: CostEntry = {
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        model: effectiveModel,
        costUsd,
        timestamp: Date.now(),
        provider,
      };

      aggregator.record(sessionId, entry);
      tokenRate.record(metrics.inputTokens, metrics.outputTokens);
      schedulePush();
    },

    flushBreakdown(): void {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      pushBreakdown();
    },

    aggregator,
    tokenRate,

    exportJson(): CostExportPayload {
      return exportCostJson(aggregator, sessionId, tokenRate);
    },

    setSession(newSessionId: string, newModelName: string, newProvider: string): void {
      sessionId = newSessionId;
      modelName = newModelName;
      provider = newProvider;
    },

    setModelName(newModelName: string): void {
      modelName = newModelName;
    },

    dispose(): void {
      if (debounceTimer !== null) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
    },
  };
}

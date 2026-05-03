/**
 * Default `ContextEngine` adapter — wraps `enforceBudget` so the existing
 * tiered-compaction policy is reachable through the pluggable slot defined by
 * issue #1767.
 *
 * Phase 2 of the pluggable context-engine slot. Identity is stable so swap
 * events produced by Phase 5 carry traceable from/to fields.
 */

import type {
  ContextEngine,
  ContextEngineIdentity,
  ContextOccupancy,
} from "@koi/core/context-engine";
import type { InboundMessage } from "@koi/core/message";
import type { TurnContext } from "@koi/core/middleware";
import type { ReplacementStore } from "@koi/core/replacement";
import { type BudgetConfig, enforceBudget } from "./enforce-budget.js";
import { FALLBACK_ESTIMATOR } from "./fallback-estimator.js";
import { COMPACTION_DEFAULTS } from "./types.js";

/** Stable identity for the bundled default engine. */
export const DEFAULT_CONTEXT_ENGINE_IDENTITY: ContextEngineIdentity = {
  name: "@koi/context-manager",
  version: "1.0.0",
} as const;

/**
 * Configuration for the default context engine. All fields are optional; any
 * field absent from `BudgetConfig` falls back to `COMPACTION_DEFAULTS`.
 */
export interface ContextEngineOptions extends BudgetConfig {
  readonly identity?: ContextEngineIdentity;
  readonly replacementStore?: ReplacementStore;
}

/**
 * Build the default `ContextEngine` backed by `enforceBudget`.
 *
 * `prepare` runs the full enforcement cascade (replacement → policy →
 * microcompact) and returns the resulting message list.
 *
 * `describeOccupancy` estimates the post-prepare token total against the
 * configured context window.
 */
export function createContextEngine(options: ContextEngineOptions = {}): ContextEngine {
  const identity = options.identity ?? DEFAULT_CONTEXT_ENGINE_IDENTITY;
  const maxTokens = options.contextWindowSize ?? COMPACTION_DEFAULTS.contextWindowSize;
  const estimator = options.tokenEstimator ?? FALLBACK_ESTIMATOR;

  // Per-engine accumulator: last-known token total feeds describeOccupancy().
  let lastEstimatedTokens = 0;

  const prepare = async (
    _ctx: TurnContext,
    messages: readonly InboundMessage[],
  ): Promise<readonly InboundMessage[]> => {
    const result = await enforceBudget(messages, options.replacementStore, options);
    // Always derive occupancy from the actual emitted message list.
    // BudgetEnforcementResult exposes pre-compaction `totalTokens` on the
    // "full" path, so reading it would keep pressure pinned at ~100% even
    // after a successful drop/summarize. Recomputing on `result.messages`
    // gives a single, authoritative post-prepare count for every branch.
    lastEstimatedTokens = await estimator.estimateMessages(result.messages, options.modelId);
    return result.messages;
  };

  const describeOccupancy = async (): Promise<ContextOccupancy> => ({
    estimatedTokens: lastEstimatedTokens,
    maxTokens,
    pressure: maxTokens > 0 ? Math.min(lastEstimatedTokens / maxTokens, 1) : 0,
  });

  return {
    identity,
    prepare,
    describeOccupancy,
  };
}

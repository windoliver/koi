/**
 * Default `ContextEngine` adapter — wraps `enforceBudget` so the existing
 * tiered-compaction policy is reachable through the pluggable slot defined by
 * issue #1767.
 *
 * Phase 2 of the pluggable context-engine slot. Identity is stable so swap
 * events produced by Phase 5 carry traceable from/to fields.
 */

import type { ContextManifestConfig } from "@koi/core/assembly";
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
 * Recognize a `ContextManifestConfig` arg shape so manifest-driven callers
 * (`createKoi` forwards `manifest.context`) get their `config` bag applied
 * instead of silently dropped. Manifest configs carry no runtime-only fields
 * (replacementStore, tokenEstimator instances) — those still come via direct
 * `ContextEngineOptions`.
 */
function isManifestConfig(
  arg: ContextEngineOptions | ContextManifestConfig,
): arg is ContextManifestConfig {
  // `ContextManifestConfig` shape: only `engine`/`version`/`config`. Any
  // other key (e.g. `contextWindowSize`, `replacementStore`) means the caller
  // passed `ContextEngineOptions` directly.
  for (const key of Object.keys(arg)) {
    if (key !== "engine" && key !== "version" && key !== "config") return false;
  }
  return true;
}

function normalizeOptions(
  arg: ContextEngineOptions | ContextManifestConfig | undefined,
): ContextEngineOptions {
  if (arg === undefined) return {};
  if (!isManifestConfig(arg)) return arg;
  // Manifest `config` is JsonObject — fields it carries are budget knobs by
  // contract. Runtime-only fields (replacementStore, tokenEstimator) cannot
  // appear in JSON, so the cast widens cleanly without losing type safety.
  const cfg = arg.config ?? {};
  const identity: ContextEngineIdentity | undefined =
    arg.engine !== undefined
      ? { name: arg.engine, version: arg.version ?? DEFAULT_CONTEXT_ENGINE_IDENTITY.version }
      : undefined;
  return {
    ...(cfg as BudgetConfig),
    ...(identity !== undefined ? { identity } : {}),
  };
}

/**
 * Build the default `ContextEngine` backed by `enforceBudget`.
 *
 * Accepts either `ContextEngineOptions` (direct host wiring) or
 * `ContextManifestConfig` (forwarded from `createKoi(manifest.context)`).
 * For manifest input, the opaque `config` bag is unwrapped into budget knobs
 * and `engine`/`version` populate engine identity.
 *
 * `prepare` runs the full enforcement cascade (replacement → policy →
 * microcompact) and returns the resulting message list.
 *
 * `describeOccupancy` estimates the post-prepare token total against the
 * configured context window.
 */
export function createContextEngine(
  arg: ContextEngineOptions | ContextManifestConfig = {},
): ContextEngine {
  const options = normalizeOptions(arg);
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

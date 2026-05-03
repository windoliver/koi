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

/**
 * Numeric budget knobs we accept from the JSON manifest bag. Strings or
 * malformed values are rejected up-front so a drifted manifest cannot push
 * `enforceBudget`'s arithmetic into NaN/noop and silently disable
 * compaction.
 */
const NUMERIC_BUDGET_KEYS = [
  "contextWindowSize",
  "preserveRecent",
  "prunePreserveLastK",
  "softTriggerFraction",
  "hardTriggerFraction",
  "microTargetFraction",
  "maxResultTokens",
  "maxMessageTokens",
  "previewChars",
  "maxSummaryTokens",
] as const satisfies readonly (keyof BudgetConfig)[];

function coerceFiniteNumber(key: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `createContextEngine: manifest.context.config.${key} must be a finite, non-negative number; got ${typeof value === "number" ? String(value) : JSON.stringify(value)}`,
    );
  }
  return value;
}

function validateManifestBudget(cfg: Readonly<Record<string, unknown>>): BudgetConfig {
  const out: Record<string, number | string> = {};
  for (const key of NUMERIC_BUDGET_KEYS) {
    const v = cfg[key];
    if (v === undefined) continue;
    out[key] = coerceFiniteNumber(key, v);
  }
  if (cfg.modelId !== undefined) {
    if (typeof cfg.modelId !== "string") {
      throw new Error(
        `createContextEngine: manifest.context.config.modelId must be a string; got ${typeof cfg.modelId}`,
      );
    }
    out.modelId = cfg.modelId;
  }
  return out as BudgetConfig;
}

function normalizeOptions(
  arg: ContextEngineOptions | ContextManifestConfig | undefined,
): ContextEngineOptions {
  if (arg === undefined) return {};
  if (!isManifestConfig(arg)) return arg;
  // Validate the JSON `config` bag before handing it to `enforceBudget`.
  // Runtime-only fields (replacementStore, tokenEstimator instances)
  // cannot appear in JSON; only numeric/string knobs are accepted.
  // Deliberately ignore arg.engine / arg.version: the bundled factory must
  // NOT claim an arbitrary identity from manifest text — createKoi compares
  // the returned identity against the manifest pin, and a fixed identity
  // makes that comparison meaningful.
  if (arg.config === undefined) return {};
  return validateManifestBudget(arg.config as Readonly<Record<string, unknown>>);
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

  // Per-turn occupancy snapshots. Overlapping turns each track their own
  // most-recent estimate so a late-completing prior turn cannot stomp a
  // newer turn's pressure with stale data. describeOccupancy reports the
  // peak across active turns, which is the load-relevant signal for
  // pressure-driven policy and operator tooling. Entries are released by
  // onAfterTurn so the map cannot grow without bound on long-running runs.
  const perTurnTokens = new Map<string, number>();

  const prepare = async (
    ctx: TurnContext,
    messages: readonly InboundMessage[],
  ): Promise<readonly InboundMessage[]> => {
    const result = await enforceBudget(messages, options.replacementStore, options);
    // Always derive occupancy from the actual emitted message list.
    // BudgetEnforcementResult exposes pre-compaction `totalTokens` on the
    // "full" path, so reading it would keep pressure pinned at ~100% even
    // after a successful drop/summarize. Recomputing on `result.messages`
    // gives a single, authoritative post-prepare count for every branch.
    const estimated = await estimator.estimateMessages(result.messages, options.modelId);
    perTurnTokens.set(ctx.turnId as string, estimated);
    // Always return a fresh array. enforceBudget's noop branch returns the
    // caller's original `messages` reference; aliasing caller-owned history
    // back as the prepared list lets downstream mutation leak into cached
    // turn state. ContextEngine.prepare() docs require a fresh list.
    return [...result.messages];
  };

  const onAfterTurn = (ctx: TurnContext): void => {
    perTurnTokens.delete(ctx.turnId as string);
  };

  const describeOccupancy = async (): Promise<ContextOccupancy> => {
    let peak = 0;
    for (const v of perTurnTokens.values()) {
      if (v > peak) peak = v;
    }
    return {
      estimatedTokens: peak,
      maxTokens,
      pressure: maxTokens > 0 ? Math.min(peak / maxTokens, 1) : 0,
    };
  };

  return {
    identity,
    prepare,
    onAfterTurn,
    describeOccupancy,
  };
}

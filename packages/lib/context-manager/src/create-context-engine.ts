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

/**
 * Stable identity for the bundled default engine. `version` mirrors the
 * artifact's `package.json#version` so manifest pins, swap events, and
 * audit trails report the actual shipped artifact rather than an
 * aspirational semver.
 */
export const DEFAULT_CONTEXT_ENGINE_IDENTITY: ContextEngineIdentity = {
  name: "@koi/context-manager",
  version: "0.0.0",
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

/** Cross-field invariants the bundled compactor relies on. Mirrors the
 *  semantic checks in resolve-config.ts so a manifest config bag cannot
 *  bypass them and produce a permanently-noop or inverted compactor.
 */
function checkBudgetInvariants(out: Readonly<Record<string, number | string>>): void {
  const fractionKeys = [
    "softTriggerFraction",
    "hardTriggerFraction",
    "microTargetFraction",
  ] as const;
  for (const key of fractionKeys) {
    const v = out[key];
    if (typeof v === "number" && !(v > 0 && v <= 1)) {
      throw new Error(`createContextEngine: manifest.context.config.${key}=${v} must be in (0, 1]`);
    }
  }
  if (typeof out.contextWindowSize === "number" && out.contextWindowSize <= 0) {
    throw new Error(
      `createContextEngine: manifest.context.config.contextWindowSize=${out.contextWindowSize} must be > 0`,
    );
  }
  // Mirror the resolveConfig() positive/integer rules so a manifest cannot
  // ship malformed compaction knobs (e.g. previewChars: 0,
  // prunePreserveLastK: 1.5) and silently change pruning/replacement
  // behavior instead of failing at boot.
  const positiveKeys = ["maxResultTokens", "maxMessageTokens", "previewChars"] as const;
  for (const key of positiveKeys) {
    const v = out[key];
    if (typeof v === "number" && v <= 0) {
      throw new Error(`createContextEngine: manifest.context.config.${key}=${v} must be > 0`);
    }
  }
  if (typeof out.prunePreserveLastK === "number" && !Number.isInteger(out.prunePreserveLastK)) {
    throw new Error(
      `createContextEngine: manifest.context.config.prunePreserveLastK=${out.prunePreserveLastK} must be an integer`,
    );
  }
  const micro = out.microTargetFraction;
  const soft = out.softTriggerFraction;
  const hard = out.hardTriggerFraction;
  if (typeof micro === "number" && typeof soft === "number" && micro >= soft) {
    throw new Error(
      `createContextEngine: microTargetFraction (${micro}) must be < softTriggerFraction (${soft})`,
    );
  }
  if (typeof soft === "number" && typeof hard === "number" && soft > hard) {
    throw new Error(
      `createContextEngine: softTriggerFraction (${soft}) must be <= hardTriggerFraction (${hard})`,
    );
  }
}

// Allowlist of every key the manifest config bag may carry. Anything
// outside this set is rejected at boot — silently dropping unknown keys
// hid schema drift across versioned manifests, which exactly defeats the
// "pinned, traceable context behavior" the slot exists to provide.
const ALLOWED_MANIFEST_CONFIG_KEYS: ReadonlySet<string> = new Set([
  ...NUMERIC_BUDGET_KEYS,
  "modelId",
]);

function validateManifestBudget(cfg: Readonly<Record<string, unknown>>): BudgetConfig {
  const unknown = Object.keys(cfg).filter((k) => !ALLOWED_MANIFEST_CONFIG_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `createContextEngine: manifest.context.config has unknown key(s): ${unknown
        .map((k) => `"${k}"`)
        .join(", ")}. Allowed keys: ${[...ALLOWED_MANIFEST_CONFIG_KEYS]
        .map((k) => `"${k}"`)
        .join(
          ", ",
        )}. Reject schema drift up-front rather than booting with defaults silently substituted.`,
    );
  }
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
  checkBudgetInvariants(out);
  return out as BudgetConfig;
}

/**
 * Cross-field invariant check applied to direct `ContextEngineOptions`
 * input. Mirrors the manifest path's `checkBudgetInvariants` so direct
 * callers cannot construct an engine that reports `pressure: 0` /
 * `maxTokens: 0` because of an out-of-range budget knob.
 */
function validateDirectOptions(opts: ContextEngineOptions): ContextEngineOptions {
  // Convert to a plain record for the same shared check. Only fields
  // present on the input are validated; defaults are applied later by
  // createContextEngine.
  const numeric: Record<string, number | string> = {};
  for (const key of NUMERIC_BUDGET_KEYS) {
    const v = (opts as Readonly<Record<string, unknown>>)[key];
    if (v !== undefined) numeric[key] = coerceFiniteNumber(key, v);
  }
  if (opts.modelId !== undefined) numeric.modelId = opts.modelId;
  checkBudgetInvariants(numeric);
  return opts;
}

function normalizeOptions(
  arg: ContextEngineOptions | ContextManifestConfig | undefined,
): ContextEngineOptions {
  if (arg === undefined) return {};
  if (!isManifestConfig(arg)) return validateDirectOptions(arg);
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

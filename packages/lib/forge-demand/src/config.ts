/**
 * Forge demand config validation — Zod for serializable parts,
 * duck-type checks for runtime interfaces (functions, RegExp).
 */

import type { ForgeBudget, KoiError, Result } from "@koi/core";
import { DEFAULT_FORGE_BUDGET, RETRYABLE_DEFAULTS } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import { DEFAULT_CONFIDENCE_WEIGHTS } from "./confidence.js";
import type { ForgeDemandConfig, HeuristicThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schemas (serializable parts only)
// ---------------------------------------------------------------------------

const forgeBudgetSchema = z.object({
  maxForgesPerSession: z.number().int().positive().optional(),
  computeTimeBudgetMs: z.number().int().positive().optional(),
  demandThreshold: z.number().min(0).max(1).optional(),
  cooldownMs: z.number().int().nonnegative().optional(),
});

const confidenceWeightsSchema = z.object({
  repeatedFailure: z.number().min(0).max(1).optional(),
  capabilityGap: z.number().min(0).max(1).optional(),
  performanceDegradation: z.number().min(0).max(1).optional(),
});

const heuristicThresholdsSchema = z.object({
  repeatedFailureCount: z.number().int().positive().optional(),
  capabilityGapOccurrences: z.number().int().positive().optional(),
  latencyDegradationAvgMs: z.number().int().positive().optional(),
  confidenceWeights: confidenceWeightsSchema.optional(),
});

const forgeDemandConfigInputSchema = z.object({
  budget: forgeBudgetSchema.optional(),
  heuristics: heuristicThresholdsSchema.optional(),
  maxPendingSignals: z.number().int().positive().optional(),
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

// Frozen at module load so accidental mutation by any consumer
// (the `readonly` types are erased at runtime) cannot leak into later
// `createDefaultForgeDemandConfig()` callers.
const DEFAULT_HEURISTIC_THRESHOLDS: HeuristicThresholds = Object.freeze({
  repeatedFailureCount: 3,
  capabilityGapOccurrences: 2,
  latencyDegradationAvgMs: 5_000,
  confidenceWeights: Object.freeze({ ...DEFAULT_CONFIDENCE_WEIGHTS }),
});

/** Default forge demand configuration (budget + heuristics). Immutable. */
export const DEFAULT_FORGE_DEMAND_CONFIG: ForgeDemandConfig = Object.freeze({
  budget: Object.freeze({ ...DEFAULT_FORGE_BUDGET }),
  heuristics: DEFAULT_HEURISTIC_THRESHOLDS,
  maxPendingSignals: 10,
});

/** Re-exported default thresholds for tests/external consumers. */
export { DEFAULT_HEURISTIC_THRESHOLDS };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a default `ForgeDemandConfig` with optional overrides. Always
 * returns a freshly cloned object — callers may mutate the result without
 * leaking changes into later calls.
 */
export function createDefaultForgeDemandConfig(
  overrides?: Partial<ForgeDemandConfig>,
): ForgeDemandConfig {
  return {
    budget: { ...DEFAULT_FORGE_BUDGET, ...overrides?.budget },
    heuristics: {
      ...DEFAULT_HEURISTIC_THRESHOLDS,
      ...overrides?.heuristics,
      confidenceWeights: {
        ...DEFAULT_CONFIDENCE_WEIGHTS,
        ...overrides?.heuristics?.confidenceWeights,
      },
    },
    maxPendingSignals: overrides?.maxPendingSignals ?? 10,
    ...(overrides?.healthTracker !== undefined && { healthTracker: overrides.healthTracker }),
    ...(overrides?.capabilityGapPatterns !== undefined && {
      capabilityGapPatterns: overrides.capabilityGapPatterns,
    }),
    ...(overrides?.userCorrectionPatterns !== undefined && {
      userCorrectionPatterns: overrides.userCorrectionPatterns,
    }),
    ...(overrides?.onDemand !== undefined && { onDemand: overrides.onDemand }),
    ...(overrides?.onDismiss !== undefined && { onDismiss: overrides.onDismiss }),
    ...(overrides?.onSessionAttached !== undefined && {
      onSessionAttached: overrides.onSessionAttached,
    }),
    // Preserve the legacy-arity opt-in flag — without this, callers who
    // pass `acceptLegacySingleArgHealthTracker: true` through this
    // helper would silently lose the flag and validation would reject
    // their otherwise-valid length-1 tracker at startup. F79 regression.
    ...(overrides?.acceptLegacySingleArgHealthTracker !== undefined && {
      acceptLegacySingleArgHealthTracker: overrides.acceptLegacySingleArgHealthTracker,
    }),
    ...(overrides?.clock !== undefined && { clock: overrides.clock }),
  };
}

// ---------------------------------------------------------------------------
// Duck-type checks
// ---------------------------------------------------------------------------

function validationError(message: string): KoiError {
  return {
    code: "VALIDATION",
    message,
    retryable: RETRYABLE_DEFAULTS.VALIDATION,
  };
}

function isHealthTrackerLike(v: unknown): boolean {
  if (v === null || v === undefined || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.getSnapshot === "function";
}

function isRegExpArray(v: unknown): v is readonly RegExp[] {
  return Array.isArray(v) && v.every((p) => p instanceof RegExp);
}

/**
 * Reject regexes whose `lastIndex` mutates across calls (`g` / `y` flags).
 * Stateful regexes make capability-gap and user-correction detection
 * dependent on prior traffic — the same input can alternate match/miss.
 */
function hasStatefulFlag(p: RegExp): boolean {
  return p.global || p.sticky;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate raw input and return a fully resolved `ForgeDemandConfig`.
 * Returns `Result.error` (no throw) when validation fails.
 */
export function validateForgeDemandConfig(raw: unknown): Result<ForgeDemandConfig, KoiError> {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ok: false, error: validationError("Config must be a non-null object") };
  }
  const c = raw as Record<string, unknown>;

  const parsed = validateWith(
    forgeDemandConfigInputSchema,
    {
      budget: c.budget,
      heuristics: c.heuristics,
      maxPendingSignals: c.maxPendingSignals,
    },
    "Forge demand config validation failed",
  );
  if (!parsed.ok) return parsed;

  if (c.healthTracker !== undefined) {
    if (!isHealthTrackerLike(c.healthTracker)) {
      return {
        ok: false,
        error: validationError("healthTracker must expose a 'getSnapshot' function"),
      };
    }
    // Length === 1 is the high-confidence legacy `(toolId)` shape. A
    // warning alone is too easy to miss in production (F75), so we
    // reject by default. Callers with a legitimate length-1 shape
    // (e.g. defaulted second parameter) can set
    // `acceptLegacySingleArgHealthTracker: true` to opt in. Rest-arg
    // wrappers report length 0 and remain silently accepted (F73).
    const fn = (c.healthTracker as { readonly getSnapshot?: { readonly length?: number } })
      .getSnapshot;
    const declaredArity = typeof fn?.length === "number" ? fn.length : 2;
    if (declaredArity === 1 && c.acceptLegacySingleArgHealthTracker !== true) {
      return {
        ok: false,
        error: validationError(
          "healthTracker.getSnapshot has declared arity 1; the detector calls " +
            "getSnapshot(sessionId, toolId). Legacy single-argument trackers " +
            "silently mis-key snapshots and disable performance_degradation. " +
            "Wrap with `(sessionId, toolId) => tracker.getSnapshot(toolId)` " +
            "or set `acceptLegacySingleArgHealthTracker: true` if your " +
            "implementation is intentional (e.g. defaulted second param).",
        ),
      };
    }
  }
  if (c.onDemand !== undefined && typeof c.onDemand !== "function") {
    return { ok: false, error: validationError("onDemand must be a function") };
  }
  if (c.onDismiss !== undefined && typeof c.onDismiss !== "function") {
    return { ok: false, error: validationError("onDismiss must be a function") };
  }
  if (c.onSessionAttached !== undefined && typeof c.onSessionAttached !== "function") {
    return { ok: false, error: validationError("onSessionAttached must be a function") };
  }
  if (c.clock !== undefined && typeof c.clock !== "function") {
    return { ok: false, error: validationError("clock must be a function") };
  }
  if (c.capabilityGapPatterns !== undefined) {
    if (!isRegExpArray(c.capabilityGapPatterns)) {
      return { ok: false, error: validationError("capabilityGapPatterns must be RegExp[]") };
    }
    if (c.capabilityGapPatterns.some(hasStatefulFlag)) {
      return {
        ok: false,
        error: validationError(
          "capabilityGapPatterns must not use 'g' or 'y' flags (stateful regex)",
        ),
      };
    }
  }
  if (c.userCorrectionPatterns !== undefined) {
    if (!isRegExpArray(c.userCorrectionPatterns)) {
      return { ok: false, error: validationError("userCorrectionPatterns must be RegExp[]") };
    }
    if (c.userCorrectionPatterns.some(hasStatefulFlag)) {
      return {
        ok: false,
        error: validationError(
          "userCorrectionPatterns must not use 'g' or 'y' flags (stateful regex)",
        ),
      };
    }
  }

  const p = parsed.value;
  const budget: ForgeBudget = {
    maxForgesPerSession: p.budget?.maxForgesPerSession ?? DEFAULT_FORGE_BUDGET.maxForgesPerSession,
    computeTimeBudgetMs: p.budget?.computeTimeBudgetMs ?? DEFAULT_FORGE_BUDGET.computeTimeBudgetMs,
    demandThreshold: p.budget?.demandThreshold ?? DEFAULT_FORGE_BUDGET.demandThreshold,
    cooldownMs: p.budget?.cooldownMs ?? DEFAULT_FORGE_BUDGET.cooldownMs,
  };

  const heuristics: HeuristicThresholds = {
    repeatedFailureCount:
      p.heuristics?.repeatedFailureCount ?? DEFAULT_HEURISTIC_THRESHOLDS.repeatedFailureCount,
    capabilityGapOccurrences:
      p.heuristics?.capabilityGapOccurrences ??
      DEFAULT_HEURISTIC_THRESHOLDS.capabilityGapOccurrences,
    latencyDegradationAvgMs:
      p.heuristics?.latencyDegradationAvgMs ?? DEFAULT_HEURISTIC_THRESHOLDS.latencyDegradationAvgMs,
    confidenceWeights: {
      repeatedFailure:
        p.heuristics?.confidenceWeights?.repeatedFailure ??
        DEFAULT_CONFIDENCE_WEIGHTS.repeatedFailure,
      capabilityGap:
        p.heuristics?.confidenceWeights?.capabilityGap ?? DEFAULT_CONFIDENCE_WEIGHTS.capabilityGap,
      performanceDegradation:
        p.heuristics?.confidenceWeights?.performanceDegradation ??
        DEFAULT_CONFIDENCE_WEIGHTS.performanceDegradation,
    },
  };

  // Build config without spreading optional fields to satisfy
  // exactOptionalPropertyTypes — only include keys when defined.
  const base = {
    budget,
    heuristics,
    maxPendingSignals: p.maxPendingSignals ?? 10,
  } as const;

  const config: ForgeDemandConfig = {
    ...base,
    ...(c.healthTracker !== undefined
      ? { healthTracker: c.healthTracker as ForgeDemandConfig["healthTracker"] }
      : {}),
    ...(c.acceptLegacySingleArgHealthTracker === true
      ? { acceptLegacySingleArgHealthTracker: true as const }
      : {}),
    ...(c.capabilityGapPatterns !== undefined
      ? { capabilityGapPatterns: c.capabilityGapPatterns as readonly RegExp[] }
      : {}),
    ...(c.userCorrectionPatterns !== undefined
      ? { userCorrectionPatterns: c.userCorrectionPatterns as readonly RegExp[] }
      : {}),
    ...(c.onDemand !== undefined ? { onDemand: c.onDemand as ForgeDemandConfig["onDemand"] } : {}),
    ...(c.onDismiss !== undefined
      ? { onDismiss: c.onDismiss as ForgeDemandConfig["onDismiss"] }
      : {}),
    ...(c.onSessionAttached !== undefined
      ? {
          onSessionAttached: c.onSessionAttached as ForgeDemandConfig["onSessionAttached"],
        }
      : {}),
    ...(c.clock !== undefined ? { clock: c.clock as ForgeDemandConfig["clock"] } : {}),
  };

  return { ok: true, value: config };
}

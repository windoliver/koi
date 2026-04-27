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
  latencyDegradationP95Ms: z.number().int().positive().optional(),
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

const DEFAULT_HEURISTIC_THRESHOLDS: HeuristicThresholds = {
  repeatedFailureCount: 3,
  capabilityGapOccurrences: 2,
  latencyDegradationP95Ms: 5_000,
  confidenceWeights: DEFAULT_CONFIDENCE_WEIGHTS,
} as const;

/** Default forge demand configuration (budget + heuristics). */
export const DEFAULT_FORGE_DEMAND_CONFIG: ForgeDemandConfig = {
  budget: DEFAULT_FORGE_BUDGET,
  heuristics: DEFAULT_HEURISTIC_THRESHOLDS,
  maxPendingSignals: 10,
} as const;

/** Re-exported default thresholds for tests/external consumers. */
export { DEFAULT_HEURISTIC_THRESHOLDS };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a default `ForgeDemandConfig` with optional overrides. */
export function createDefaultForgeDemandConfig(
  overrides?: Partial<ForgeDemandConfig>,
): ForgeDemandConfig {
  if (overrides === undefined) return DEFAULT_FORGE_DEMAND_CONFIG;
  return {
    ...DEFAULT_FORGE_DEMAND_CONFIG,
    ...overrides,
    budget:
      overrides.budget !== undefined
        ? { ...DEFAULT_FORGE_BUDGET, ...overrides.budget }
        : DEFAULT_FORGE_BUDGET,
    heuristics:
      overrides.heuristics !== undefined
        ? { ...DEFAULT_HEURISTIC_THRESHOLDS, ...overrides.heuristics }
        : DEFAULT_HEURISTIC_THRESHOLDS,
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
  return typeof obj.getHealthSnapshot === "function" && typeof obj.isQuarantined === "function";
}

function isRegExpArray(v: unknown): v is readonly RegExp[] {
  return Array.isArray(v) && v.every((p) => p instanceof RegExp);
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

  if (c.healthTracker !== undefined && !isHealthTrackerLike(c.healthTracker)) {
    return {
      ok: false,
      error: validationError(
        "healthTracker must have 'getHealthSnapshot' and 'isQuarantined' functions",
      ),
    };
  }
  if (c.onDemand !== undefined && typeof c.onDemand !== "function") {
    return { ok: false, error: validationError("onDemand must be a function") };
  }
  if (c.onDismiss !== undefined && typeof c.onDismiss !== "function") {
    return { ok: false, error: validationError("onDismiss must be a function") };
  }
  if (c.clock !== undefined && typeof c.clock !== "function") {
    return { ok: false, error: validationError("clock must be a function") };
  }
  if (c.capabilityGapPatterns !== undefined && !isRegExpArray(c.capabilityGapPatterns)) {
    return { ok: false, error: validationError("capabilityGapPatterns must be RegExp[]") };
  }
  if (c.userCorrectionPatterns !== undefined && !isRegExpArray(c.userCorrectionPatterns)) {
    return { ok: false, error: validationError("userCorrectionPatterns must be RegExp[]") };
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
    latencyDegradationP95Ms:
      p.heuristics?.latencyDegradationP95Ms ?? DEFAULT_HEURISTIC_THRESHOLDS.latencyDegradationP95Ms,
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
    ...(c.clock !== undefined ? { clock: c.clock as ForgeDemandConfig["clock"] } : {}),
  };

  return { ok: true, value: config };
}

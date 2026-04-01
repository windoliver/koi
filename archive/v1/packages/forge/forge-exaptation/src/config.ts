/**
 * Exaptation config validation — Zod schema for serializable parts,
 * duck-type checks for runtime interfaces.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import { validateWith } from "@koi/validation";
import { z } from "zod";
import type { ExaptationConfig, ExaptationThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Zod schemas (serializable parts only)
// ---------------------------------------------------------------------------

const exaptationThresholdsSchema = z.object({
  minObservations: z.number().int().positive().optional(),
  divergenceThreshold: z.number().min(0).max(1).optional(),
  minDivergentAgents: z.number().int().positive().optional(),
  confidenceWeight: z.number().min(0).max(1).optional(),
});

const exaptationConfigInputSchema = z.object({
  cooldownMs: z.number().int().nonnegative().optional(),
  maxPendingSignals: z.number().int().positive().optional(),
  maxObservationsPerBrick: z.number().int().positive().optional(),
  maxContextWords: z.number().int().positive().optional(),
  thresholds: exaptationThresholdsSchema.optional(),
});

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
  confidenceWeight: 0.8,
} as const;

/** Default exaptation detection configuration. */
export const DEFAULT_EXAPTATION_CONFIG: ExaptationConfig = {
  cooldownMs: 60_000,
  maxPendingSignals: 10,
  maxObservationsPerBrick: 30,
  maxContextWords: 200,
  thresholds: DEFAULT_THRESHOLDS,
} as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Create a default ExaptationConfig with optional overrides. */
export function createDefaultExaptationConfig(
  overrides?: Partial<ExaptationConfig>,
): ExaptationConfig {
  if (overrides === undefined) return DEFAULT_EXAPTATION_CONFIG;
  return {
    ...DEFAULT_EXAPTATION_CONFIG,
    ...overrides,
    thresholds:
      overrides.thresholds !== undefined
        ? { ...DEFAULT_THRESHOLDS, ...overrides.thresholds }
        : DEFAULT_THRESHOLDS,
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate raw input and resolve a full ExaptationConfig with defaults.
 *
 * @param raw - Unknown input to validate.
 * @returns Result containing the fully resolved config or a validation error.
 */
export function validateExaptationConfig(raw: unknown): Result<ExaptationConfig, KoiError> {
  if (raw === null || raw === undefined || typeof raw !== "object") {
    return { ok: false, error: validationError("Config must be a non-null object") };
  }

  const c = raw as Record<string, unknown>;

  // Validate serializable parts with Zod
  const parsed = validateWith(
    exaptationConfigInputSchema,
    {
      cooldownMs: c.cooldownMs,
      maxPendingSignals: c.maxPendingSignals,
      maxObservationsPerBrick: c.maxObservationsPerBrick,
      maxContextWords: c.maxContextWords,
      thresholds: c.thresholds,
    },
    "Exaptation config validation failed",
  );
  if (!parsed.ok) return parsed;

  // Duck-type check: onSignal, onDismiss
  if (c.onSignal !== undefined && typeof c.onSignal !== "function") {
    return { ok: false, error: validationError("onSignal must be a function") };
  }
  if (c.onDismiss !== undefined && typeof c.onDismiss !== "function") {
    return { ok: false, error: validationError("onDismiss must be a function") };
  }

  // Duck-type check: clock
  if (c.clock !== undefined && typeof c.clock !== "function") {
    return { ok: false, error: validationError("clock must be a function") };
  }

  // Resolve config with defaults
  const p = parsed.value;
  const thresholds: ExaptationThresholds =
    p.thresholds !== undefined
      ? {
          minObservations: p.thresholds.minObservations ?? DEFAULT_THRESHOLDS.minObservations,
          divergenceThreshold:
            p.thresholds.divergenceThreshold ?? DEFAULT_THRESHOLDS.divergenceThreshold,
          minDivergentAgents:
            p.thresholds.minDivergentAgents ?? DEFAULT_THRESHOLDS.minDivergentAgents,
          confidenceWeight: p.thresholds.confidenceWeight ?? DEFAULT_THRESHOLDS.confidenceWeight,
        }
      : DEFAULT_THRESHOLDS;

  const config: ExaptationConfig = {
    cooldownMs: p.cooldownMs ?? DEFAULT_EXAPTATION_CONFIG.cooldownMs,
    maxPendingSignals: p.maxPendingSignals ?? DEFAULT_EXAPTATION_CONFIG.maxPendingSignals,
    maxObservationsPerBrick:
      p.maxObservationsPerBrick ?? DEFAULT_EXAPTATION_CONFIG.maxObservationsPerBrick,
    maxContextWords: p.maxContextWords ?? DEFAULT_EXAPTATION_CONFIG.maxContextWords,
    thresholds,
    onSignal: c.onSignal as ExaptationConfig["onSignal"],
    onDismiss: c.onDismiss as ExaptationConfig["onDismiss"],
    clock: c.clock as ExaptationConfig["clock"],
  };

  return { ok: true, value: config };
}

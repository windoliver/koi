/**
 * Configuration validation and defaults for the collusion detector.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { CollusionDetectorConfig, CollusionThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default thresholds for collusion detection signals. */
export const DEFAULT_COLLUSION_THRESHOLDS: Readonly<CollusionThresholds> = Object.freeze({
  syncMoveMinAgents: 3,
  syncMoveChangePct: 0.2,
  varianceCollapseMaxCv: 0.1,
  varianceCollapseMinRounds: 5,
  concentrationHhiThreshold: 0.25,
  specializationCvMin: 2.0,
});

const DEFAULT_WINDOW_SIZE = 50;

// ---------------------------------------------------------------------------
// resolveThresholds — merge user overrides with defaults
// ---------------------------------------------------------------------------

/** Resolve collusion thresholds from optional partial overrides. */
export function resolveThresholds(
  overrides?: Partial<CollusionThresholds> | undefined,
): CollusionThresholds {
  return { ...DEFAULT_COLLUSION_THRESHOLDS, ...overrides };
}

/** Resolve window size from optional config value. */
export function resolveWindowSize(windowSize?: number | undefined): number {
  return windowSize ?? DEFAULT_WINDOW_SIZE;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a collusion detector configuration.
 *
 * Checks:
 * - config is a non-null object
 * - threshold values (if present) are positive finite numbers
 * - windowSize (if present) is a positive integer
 */
export function validateCollusionDetectorConfig(
  config: unknown,
): Result<CollusionDetectorConfig, KoiError> {
  if (!isRecord(config)) {
    return validationError("Config must be a non-null object");
  }

  // Validate windowSize
  if (config.windowSize !== undefined) {
    if (
      typeof config.windowSize !== "number" ||
      config.windowSize <= 0 ||
      !Number.isInteger(config.windowSize)
    ) {
      return validationError("'windowSize' must be a positive integer");
    }
  }

  // Validate thresholds
  if (config.thresholds !== undefined) {
    if (!isRecord(config.thresholds)) {
      return validationError("'thresholds' must be a non-null object");
    }

    const t = config.thresholds;
    const numericFields = [
      "syncMoveMinAgents",
      "syncMoveChangePct",
      "varianceCollapseMaxCv",
      "varianceCollapseMinRounds",
      "concentrationHhiThreshold",
      "specializationCvMin",
    ] as const;

    for (const field of numericFields) {
      const fieldVal = t[field];
      if (fieldVal !== undefined) {
        if (typeof fieldVal !== "number" || !Number.isFinite(fieldVal) || fieldVal <= 0) {
          return validationError(`'thresholds.${field}' must be a positive finite number`);
        }
      }
    }
  }

  // All validations passed — config shape is verified
  return { ok: true, value: config as CollusionDetectorConfig };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function validationError(message: string): Result<never, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

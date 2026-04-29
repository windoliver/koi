/**
 * RLM middleware — config validation.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { RlmConfig } from "./types.js";

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function isPositiveInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0
  );
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isEstimator(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const e = value as Record<string, unknown>;
  return typeof e.estimateText === "function" && typeof e.estimateMessages === "function";
}

/**
 * Validate {@link RlmConfig}. Returns an `ok: true` result with the original
 * config on success or a `VALIDATION` error otherwise.
 */
export function validateRlmConfig(config: unknown): Result<RlmConfig, KoiError> {
  if (config === undefined) {
    return { ok: true, value: {} };
  }
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return validationError("Config must be an object");
  }
  const c = config as Record<string, unknown>;

  if (c.maxInputTokens !== undefined && !isPositiveInteger(c.maxInputTokens)) {
    return validationError("'maxInputTokens' must be a positive integer");
  }
  if (c.maxChunkChars !== undefined && !isPositiveInteger(c.maxChunkChars)) {
    return validationError("'maxChunkChars' must be a positive integer");
  }
  if (c.priority !== undefined && (!isFiniteNumber(c.priority) || !Number.isInteger(c.priority))) {
    return validationError("'priority' must be an integer");
  }
  if (c.estimator !== undefined && !isEstimator(c.estimator)) {
    return validationError("'estimator' must implement the TokenEstimator interface");
  }
  if (c.onEvent !== undefined && typeof c.onEvent !== "function") {
    return validationError("'onEvent' must be a function");
  }
  if (
    c.acknowledgeSegmentLocalContract !== undefined &&
    typeof c.acknowledgeSegmentLocalContract !== "boolean"
  ) {
    return validationError("'acknowledgeSegmentLocalContract' must be a boolean");
  }

  return { ok: true, value: c as RlmConfig };
}

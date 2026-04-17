/**
 * Planning middleware configuration validation.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type { PlanConfig } from "./types.js";

function validationError(message: string): { readonly ok: false; readonly error: KoiError } {
  return {
    ok: false,
    error: { code: "VALIDATION", message, retryable: RETRYABLE_DEFAULTS.VALIDATION },
  };
}

export function validatePlanConfig(config: unknown): Result<PlanConfig, KoiError> {
  if (config === null || config === undefined) {
    return { ok: true, value: {} };
  }

  if (typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (c.onPlanUpdate !== undefined && typeof c.onPlanUpdate !== "function") {
    return validationError("onPlanUpdate must be a function");
  }

  if (c.priority !== undefined) {
    if (typeof c.priority !== "number" || !Number.isInteger(c.priority) || c.priority < 0) {
      return validationError("priority must be a non-negative integer");
    }
  }

  return { ok: true, value: config as PlanConfig };
}

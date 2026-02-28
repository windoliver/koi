/**
 * Tool audit middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ToolAuditResult, ToolAuditStore } from "./types.js";

export interface ToolAuditConfig {
  readonly store?: ToolAuditStore;
  readonly unusedThresholdSessions?: number;
  readonly lowAdoptionThreshold?: number;
  readonly highFailureThreshold?: number;
  readonly highValueSuccessThreshold?: number;
  readonly highValueMinCalls?: number;
  readonly minCallsForFailure?: number;
  readonly minSessionsForAdoption?: number;
  readonly onAuditResult?: (results: readonly ToolAuditResult[]) => void;
  readonly onError?: (error: unknown) => void;
  readonly clock?: () => number;
}

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

function isFinitePositive(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function validateToolAuditConfig(config: unknown): Result<ToolAuditConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (c.store !== undefined && (c.store === null || typeof c.store !== "object")) {
    return validationError("'store' must be an object with load and save methods");
  }

  if (c.store !== undefined) {
    const store = c.store as Record<string, unknown>;
    if (typeof store.load !== "function" || typeof store.save !== "function") {
      return validationError("'store' must have load and save methods");
    }
  }

  if (c.unusedThresholdSessions !== undefined && !isFinitePositive(c.unusedThresholdSessions)) {
    return validationError("'unusedThresholdSessions' must be a positive finite number");
  }

  if (
    c.lowAdoptionThreshold !== undefined &&
    (!isFiniteNonNegative(c.lowAdoptionThreshold) ||
      (typeof c.lowAdoptionThreshold === "number" && c.lowAdoptionThreshold > 1))
  ) {
    return validationError("'lowAdoptionThreshold' must be a number between 0 and 1");
  }

  if (
    c.highFailureThreshold !== undefined &&
    (!isFiniteNonNegative(c.highFailureThreshold) ||
      (typeof c.highFailureThreshold === "number" && c.highFailureThreshold > 1))
  ) {
    return validationError("'highFailureThreshold' must be a number between 0 and 1");
  }

  if (
    c.highValueSuccessThreshold !== undefined &&
    (!isFiniteNonNegative(c.highValueSuccessThreshold) ||
      (typeof c.highValueSuccessThreshold === "number" && c.highValueSuccessThreshold > 1))
  ) {
    return validationError("'highValueSuccessThreshold' must be a number between 0 and 1");
  }

  if (c.highValueMinCalls !== undefined && !isFinitePositive(c.highValueMinCalls)) {
    return validationError("'highValueMinCalls' must be a positive finite number");
  }

  if (c.minCallsForFailure !== undefined && !isFinitePositive(c.minCallsForFailure)) {
    return validationError("'minCallsForFailure' must be a positive finite number");
  }

  if (c.minSessionsForAdoption !== undefined && !isFinitePositive(c.minSessionsForAdoption)) {
    return validationError("'minSessionsForAdoption' must be a positive finite number");
  }

  if (c.onAuditResult !== undefined && typeof c.onAuditResult !== "function") {
    return validationError("'onAuditResult' must be a function");
  }

  if (c.onError !== undefined && typeof c.onError !== "function") {
    return validationError("'onError' must be a function");
  }

  if (c.clock !== undefined && typeof c.clock !== "function") {
    return validationError("'clock' must be a function");
  }

  return { ok: true, value: config as ToolAuditConfig };
}

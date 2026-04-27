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
  /**
   * Maximum time `onSessionEnd` waits for in-flight tool calls to settle
   * before folding+persisting whatever local state exists. Bounds the
   * drain so a hung tool on a dead dependency cannot wedge session
   * teardown indefinitely (#review-round37-F1). Default 5000 ms. Set
   * Infinity to disable the timeout (round-36 unbounded behavior).
   */
  readonly sessionEndDrainTimeoutMs?: number;
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

function isFiniteRatio(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateStore(c: Record<string, unknown>): Result<true, KoiError> {
  if (c.store === undefined) return { ok: true, value: true };
  if (c.store === null || typeof c.store !== "object") {
    return validationError("'store' must be an object with load and save methods");
  }
  const store = c.store as Record<string, unknown>;
  if (typeof store.load !== "function" || typeof store.save !== "function") {
    return validationError("'store' must have load and save methods");
  }
  return { ok: true, value: true };
}

const POSITIVE_FIELDS = [
  "unusedThresholdSessions",
  "highValueMinCalls",
  "minCallsForFailure",
  "minSessionsForAdoption",
] as const;

const RATIO_FIELDS = [
  "lowAdoptionThreshold",
  "highFailureThreshold",
  "highValueSuccessThreshold",
] as const;

const CALLBACK_FIELDS = ["onAuditResult", "onError", "clock"] as const;

function validateNumericFields(c: Record<string, unknown>): Result<true, KoiError> {
  for (const field of POSITIVE_FIELDS) {
    if (c[field] !== undefined && !isFinitePositive(c[field])) {
      return validationError(`'${field}' must be a positive finite number`);
    }
  }
  for (const field of RATIO_FIELDS) {
    if (c[field] !== undefined && !isFiniteRatio(c[field])) {
      return validationError(`'${field}' must be a number between 0 and 1`);
    }
  }
  if (c.sessionEndDrainTimeoutMs !== undefined) {
    const v = c.sessionEndDrainTimeoutMs;
    // Allow Infinity (caller opts out of the timeout). Otherwise must be
    // a non-negative finite number.
    const valid =
      typeof v === "number" && !Number.isNaN(v) && (v === Number.POSITIVE_INFINITY || v >= 0);
    if (!valid) {
      return validationError(
        "'sessionEndDrainTimeoutMs' must be a non-negative number or Infinity",
      );
    }
  }
  return { ok: true, value: true };
}

function validateCallbacks(c: Record<string, unknown>): Result<true, KoiError> {
  for (const field of CALLBACK_FIELDS) {
    if (c[field] !== undefined && typeof c[field] !== "function") {
      return validationError(`'${field}' must be a function`);
    }
  }
  return { ok: true, value: true };
}

export function validateToolAuditConfig(config: unknown): Result<ToolAuditConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  const storeCheck = validateStore(c);
  if (!storeCheck.ok) return storeCheck;
  const numericCheck = validateNumericFields(c);
  if (!numericCheck.ok) return numericCheck;
  const callbackCheck = validateCallbacks(c);
  if (!callbackCheck.ok) return callbackCheck;

  return { ok: true, value: c as ToolAuditConfig };
}

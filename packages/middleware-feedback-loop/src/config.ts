/**
 * FeedbackLoopConfig definition and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { RepairStrategy, RetryConfig, ValidationError, Validator } from "./types.js";

/** Configuration for the feedback-loop middleware. */
export interface FeedbackLoopConfig {
  /** Model call validators — failure triggers retry with error feedback. */
  readonly validators?: readonly Validator[];
  /** Model call gates — failure halts without retry. */
  readonly gates?: readonly Validator[];
  /** Tool call input validators — failure rejects before execution. */
  readonly toolValidators?: readonly Validator[];
  /** Tool call output gates — failure halts after execution. */
  readonly toolGates?: readonly Validator[];
  /** Category-aware retry budget configuration. */
  readonly retry?: RetryConfig;
  /** Custom repair strategy (default appends errors as user message). */
  readonly repairStrategy?: RepairStrategy;
  /** Called on each validation retry attempt. */
  readonly onRetry?: (attempt: number, errors: readonly ValidationError[]) => void;
  /** Called when a gate check fails. */
  readonly onGateFail?: (gateName: string, errors: readonly ValidationError[]) => void;
}

function isValidatorLike(v: unknown): boolean {
  if (v === null || v === undefined || typeof v !== "object") return false;
  const obj = v as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.validate === "function";
}

function validateValidatorArray(arr: unknown, fieldName: string): KoiError | undefined {
  if (!Array.isArray(arr)) {
    return {
      code: "VALIDATION",
      message: `${fieldName} must be an array`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }
  for (const item of arr as readonly unknown[]) {
    if (!isValidatorLike(item)) {
      return {
        code: "VALIDATION",
        message: `Each entry in ${fieldName} must have a string 'name' and a 'validate' function`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
  }
  return undefined;
}

function validateRetryConfig(retry: unknown): KoiError | undefined {
  if (typeof retry !== "object" || retry === null) {
    return {
      code: "VALIDATION",
      message: "retry must be an object",
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }

  const r = retry as Record<string, unknown>;

  if (r.validation !== undefined) {
    if (typeof r.validation !== "object" || r.validation === null) {
      return {
        code: "VALIDATION",
        message: "retry.validation must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
    const v = r.validation as Record<string, unknown>;
    if (v.maxAttempts !== undefined && (typeof v.maxAttempts !== "number" || v.maxAttempts < 0)) {
      return {
        code: "VALIDATION",
        message: "retry.validation.maxAttempts must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
    if (v.delayMs !== undefined && (typeof v.delayMs !== "number" || v.delayMs < 0)) {
      return {
        code: "VALIDATION",
        message: "retry.validation.delayMs must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
  }

  if (r.transport !== undefined) {
    if (typeof r.transport !== "object" || r.transport === null) {
      return {
        code: "VALIDATION",
        message: "retry.transport must be an object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
    const t = r.transport as Record<string, unknown>;
    if (t.maxAttempts !== undefined && (typeof t.maxAttempts !== "number" || t.maxAttempts < 0)) {
      return {
        code: "VALIDATION",
        message: "retry.transport.maxAttempts must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
    if (t.baseDelayMs !== undefined && (typeof t.baseDelayMs !== "number" || t.baseDelayMs < 0)) {
      return {
        code: "VALIDATION",
        message: "retry.transport.baseDelayMs must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
    if (t.maxDelayMs !== undefined && (typeof t.maxDelayMs !== "number" || t.maxDelayMs < 0)) {
      return {
        code: "VALIDATION",
        message: "retry.transport.maxDelayMs must be a non-negative number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      };
    }
  }

  return undefined;
}

/** Validates a config object and returns a typed Result. */
export function validateConfig(config: unknown): Result<FeedbackLoopConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "Config must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  // Validate validator/gate arrays if present
  const arrayFields = ["validators", "gates", "toolValidators", "toolGates"] as const;
  for (const field of arrayFields) {
    if (c[field] !== undefined) {
      const err = validateValidatorArray(c[field], field);
      if (err) return { ok: false, error: err };
    }
  }

  // Validate retry config if present
  if (c.retry !== undefined) {
    const err = validateRetryConfig(c.retry);
    if (err) return { ok: false, error: err };
  }

  // Validate repairStrategy if present
  if (c.repairStrategy !== undefined) {
    if (
      typeof c.repairStrategy !== "object" ||
      c.repairStrategy === null ||
      typeof (c.repairStrategy as Record<string, unknown>).buildRetryRequest !== "function"
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "repairStrategy must have a 'buildRetryRequest' function",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: config as FeedbackLoopConfig };
}

/**
 * Reflex middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { ReflexMetrics, ReflexRule } from "./types.js";

export interface ReflexMiddlewareConfig {
  readonly rules: readonly ReflexRule[];
  /** Master switch. Default: true. */
  readonly enabled?: boolean | undefined;
  /** Clock injection for deterministic tests. */
  readonly now?: (() => number) | undefined;
  /** Observability callback fired after each evaluation cycle. */
  readonly onMetrics?: ((metrics: ReflexMetrics) => void) | undefined;
}

export const DEFAULT_PRIORITY = 100;
export const DEFAULT_COOLDOWN_MS = 0;

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

function isFiniteNonNegative(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validateRule(rule: unknown, index: number): KoiError | undefined {
  if (rule === null || typeof rule !== "object") {
    return {
      code: "VALIDATION",
      message: `rules[${index}] must be an object`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }

  const r = rule as Record<string, unknown>;

  if (typeof r.name !== "string" || r.name.length === 0) {
    return {
      code: "VALIDATION",
      message: `rules[${index}].name must be a non-empty string`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }

  if (typeof r.match !== "function") {
    return {
      code: "VALIDATION",
      message: `rules[${index}].match must be a function`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }

  if (typeof r.respond !== "function") {
    return {
      code: "VALIDATION",
      message: `rules[${index}].respond must be a function`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }

  if (r.priority !== undefined && !isFiniteNonNegative(r.priority)) {
    return {
      code: "VALIDATION",
      message: `rules[${index}].priority must be a finite non-negative number`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }

  if (r.cooldownMs !== undefined && !isFiniteNonNegative(r.cooldownMs)) {
    return {
      code: "VALIDATION",
      message: `rules[${index}].cooldownMs must be a finite non-negative number`,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    };
  }

  return undefined;
}

/**
 * Validates raw config input into a typed ReflexMiddlewareConfig.
 */
export function validateReflexConfig(config: unknown): Result<ReflexMiddlewareConfig, KoiError> {
  if (
    config === null ||
    config === undefined ||
    typeof config !== "object" ||
    Array.isArray(config)
  ) {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (!Array.isArray(c.rules)) {
    return validationError("'rules' must be a non-empty array");
  }

  if (c.rules.length === 0) {
    return validationError("'rules' must be a non-empty array");
  }

  for (const [i, rule] of (c.rules as readonly unknown[]).entries()) {
    const ruleError = validateRule(rule, i);
    if (ruleError !== undefined) {
      return { ok: false, error: ruleError };
    }
  }

  if (c.enabled !== undefined && typeof c.enabled !== "boolean") {
    return validationError("'enabled' must be a boolean");
  }

  if (c.now !== undefined && typeof c.now !== "function") {
    return validationError("'now' must be a function");
  }

  if (c.onMetrics !== undefined && typeof c.onMetrics !== "function") {
    return validationError("'onMetrics' must be a function");
  }

  return { ok: true, value: config as ReflexMiddlewareConfig };
}

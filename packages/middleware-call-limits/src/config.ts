/**
 * Call limit middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type {
  CallLimitStore,
  LimitReachedInfo,
  ModelExitBehavior,
  ToolExitBehavior,
} from "./types.js";

export interface ModelCallLimitConfig {
  readonly limit: number;
  readonly store?: CallLimitStore;
  readonly exitBehavior?: ModelExitBehavior;
  readonly onLimitReached?: (info: LimitReachedInfo) => void;
}

export interface ToolCallLimitConfig {
  readonly limits?: Readonly<Record<string, number>>;
  readonly globalLimit?: number;
  readonly store?: CallLimitStore;
  readonly exitBehavior?: ToolExitBehavior;
  readonly onLimitReached?: (info: LimitReachedInfo) => void;
}

const VALID_MODEL_EXIT_BEHAVIORS = new Set<string>(["end", "error"]);
const VALID_TOOL_EXIT_BEHAVIORS = new Set<string>(["continue", "end", "error"]);

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

export function validateModelCallLimitConfig(
  config: unknown,
): Result<ModelCallLimitConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  if (typeof c.limit !== "number" || !Number.isFinite(c.limit) || c.limit < 0) {
    return validationError("Config requires a non-negative finite 'limit' number");
  }

  if (!Number.isInteger(c.limit)) {
    return validationError("'limit' must be an integer");
  }

  if (c.store !== undefined && (c.store === null || typeof c.store !== "object")) {
    return validationError("'store' must be an object with get/increment/reset methods");
  }

  if (c.store !== undefined) {
    const store = c.store as Record<string, unknown>;
    if (
      typeof store.get !== "function" ||
      typeof store.increment !== "function" ||
      typeof store.reset !== "function"
    ) {
      return validationError("'store' must have get, increment, and reset methods");
    }
  }

  if (
    c.exitBehavior !== undefined &&
    (typeof c.exitBehavior !== "string" || !VALID_MODEL_EXIT_BEHAVIORS.has(c.exitBehavior))
  ) {
    return validationError('\'exitBehavior\' must be "end" or "error"');
  }

  if (c.onLimitReached !== undefined && typeof c.onLimitReached !== "function") {
    return validationError("'onLimitReached' must be a function");
  }

  return { ok: true, value: config as ModelCallLimitConfig };
}

export function validateToolCallLimitConfig(
  config: unknown,
): Result<ToolCallLimitConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  const hasLimits = c.limits !== undefined;
  const hasGlobalLimit = c.globalLimit !== undefined;

  if (!hasLimits && !hasGlobalLimit) {
    return validationError("Config requires at least one of 'limits' or 'globalLimit'");
  }

  if (hasLimits) {
    if (c.limits === null || typeof c.limits !== "object" || Array.isArray(c.limits)) {
      return validationError("'limits' must be a non-null object mapping tool IDs to numbers");
    }
    const limits = c.limits as Record<string, unknown>;
    for (const [toolId, value] of Object.entries(limits)) {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return validationError(`'limits.${toolId}' must be a non-negative finite number`);
      }
      if (!Number.isInteger(value)) {
        return validationError(`'limits.${toolId}' must be an integer`);
      }
    }
  }

  if (hasGlobalLimit) {
    if (typeof c.globalLimit !== "number" || !Number.isFinite(c.globalLimit) || c.globalLimit < 0) {
      return validationError("'globalLimit' must be a non-negative finite number");
    }
    if (!Number.isInteger(c.globalLimit)) {
      return validationError("'globalLimit' must be an integer");
    }
  }

  if (c.store !== undefined && (c.store === null || typeof c.store !== "object")) {
    return validationError("'store' must be an object with get/increment/reset methods");
  }

  if (c.store !== undefined) {
    const store = c.store as Record<string, unknown>;
    if (
      typeof store.get !== "function" ||
      typeof store.increment !== "function" ||
      typeof store.reset !== "function"
    ) {
      return validationError("'store' must have get, increment, and reset methods");
    }
  }

  if (
    c.exitBehavior !== undefined &&
    (typeof c.exitBehavior !== "string" || !VALID_TOOL_EXIT_BEHAVIORS.has(c.exitBehavior))
  ) {
    return validationError('\'exitBehavior\' must be "continue", "end", or "error"');
  }

  if (c.onLimitReached !== undefined && typeof c.onLimitReached !== "function") {
    return validationError("'onLimitReached' must be a function");
  }

  return { ok: true, value: config as ToolCallLimitConfig };
}

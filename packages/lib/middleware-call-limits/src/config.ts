/**
 * Call limits middleware — config types and validation.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";
import type {
  CallLimitStore,
  LimitReachedInfo,
  ModelExitBehavior,
  ToolExitBehavior,
} from "./types.js";

export interface ToolCallLimitConfig {
  readonly limits?: Readonly<Record<string, number>>;
  readonly globalLimit?: number;
  readonly store?: CallLimitStore;
  readonly exitBehavior?: ToolExitBehavior;
  readonly onLimitReached?: (info: LimitReachedInfo) => void;
}

export interface ModelCallLimitConfig {
  readonly limit: number;
  readonly store?: CallLimitStore;
  readonly exitBehavior?: ModelExitBehavior;
  readonly onLimitReached?: (info: LimitReachedInfo) => void;
}

const VALID_TOOL_EXIT = new Set<string>(["continue", "error"]);
const VALID_MODEL_EXIT = new Set<string>(["error"]);

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

function isNonNegativeInteger(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
  );
}

function isValidStore(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    typeof s.get === "function" &&
    typeof s.increment === "function" &&
    typeof s.decrement === "function" &&
    typeof s.reset === "function" &&
    typeof s.incrementIfBelow === "function"
  );
}

export function validateToolCallLimitConfig(
  config: unknown,
): Result<ToolCallLimitConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }
  if (Array.isArray(config)) {
    return validationError("Config must be a non-null object");
  }
  const c = config as Record<string, unknown>;

  const hasLimits = c.limits !== undefined;
  const hasGlobal = c.globalLimit !== undefined;
  if (!hasLimits && !hasGlobal) {
    return validationError("Config requires at least one of 'limits' or 'globalLimit'");
  }

  if (hasLimits) {
    if (c.limits === null || typeof c.limits !== "object" || Array.isArray(c.limits)) {
      return validationError("'limits' must be a non-null object mapping tool IDs to integers");
    }
    for (const [toolId, value] of Object.entries(c.limits)) {
      if (!isNonNegativeInteger(value)) {
        return validationError(`'limits.${toolId}' must be a non-negative integer`);
      }
    }
  }

  if (hasGlobal && !isNonNegativeInteger(c.globalLimit)) {
    return validationError("'globalLimit' must be a non-negative integer");
  }

  if (c.store !== undefined && !isValidStore(c.store)) {
    return validationError(
      "'store' must implement get, increment, decrement, reset, incrementIfBelow",
    );
  }

  if (
    c.exitBehavior !== undefined &&
    (typeof c.exitBehavior !== "string" || !VALID_TOOL_EXIT.has(c.exitBehavior))
  ) {
    return validationError('\'exitBehavior\' must be "continue" or "error"');
  }

  if (c.onLimitReached !== undefined && typeof c.onLimitReached !== "function") {
    return validationError("'onLimitReached' must be a function");
  }

  return { ok: true, value: config as ToolCallLimitConfig };
}

export function validateModelCallLimitConfig(
  config: unknown,
): Result<ModelCallLimitConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("Config must be a non-null object");
  }
  if (Array.isArray(config)) {
    return validationError("Config must be a non-null object");
  }
  const c = config as Record<string, unknown>;

  if (!isNonNegativeInteger(c.limit)) {
    return validationError("'limit' must be a non-negative integer");
  }

  if (c.store !== undefined && !isValidStore(c.store)) {
    return validationError(
      "'store' must implement get, increment, decrement, reset, incrementIfBelow",
    );
  }

  if (
    c.exitBehavior !== undefined &&
    (typeof c.exitBehavior !== "string" || !VALID_MODEL_EXIT.has(c.exitBehavior))
  ) {
    return validationError("'exitBehavior' must be \"error\"");
  }

  if (c.onLimitReached !== undefined && typeof c.onLimitReached !== "function") {
    return validationError("'onLimitReached' must be a function");
  }

  return { ok: true, value: config as ModelCallLimitConfig };
}

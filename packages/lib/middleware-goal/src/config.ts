/**
 * Goal middleware configuration and validation.
 */

import type { KoiError, Result } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

export interface GoalMiddlewareConfig {
  /** Objective strings to track. At least one required. */
  readonly objectives: readonly string[];
  /** Header text for the injected goal message. Default: "## Active Goals". */
  readonly header?: string | undefined;
  /** Turns between goal reminders. Default: 5. */
  readonly baseInterval?: number | undefined;
  /** Maximum interval between reminders. Default: 20. */
  readonly maxInterval?: number | undefined;
  /** Called when an objective is heuristically detected as completed. */
  readonly onComplete?: ((objective: string) => void) | undefined;
}

export const DEFAULT_GOAL_HEADER = "## Active Goals";
export const DEFAULT_BASE_INTERVAL = 5;
export const DEFAULT_MAX_INTERVAL = 20;

export function validateGoalConfig(input: unknown): Result<GoalMiddlewareConfig, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalMiddlewareConfig must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = input as Record<string, unknown>;

  if (!Array.isArray(c.objectives) || c.objectives.length === 0) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalMiddlewareConfig.objectives must be a non-empty array of strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  for (const obj of c.objectives) {
    if (typeof obj !== "string" || obj.trim().length === 0) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "Each objective must be a non-empty string",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.baseInterval !== undefined && (typeof c.baseInterval !== "number" || c.baseInterval < 1)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalMiddlewareConfig.baseInterval must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.maxInterval !== undefined && (typeof c.maxInterval !== "number" || c.maxInterval < 1)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalMiddlewareConfig.maxInterval must be a positive number",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input as GoalMiddlewareConfig };
}

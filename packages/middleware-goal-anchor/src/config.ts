/**
 * GoalAnchorConfig and validation for @koi/middleware-goal-anchor.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { TodoItem } from "./types.js";

export interface GoalAnchorConfig {
  /** Required: declared task objectives. Empty array disables the middleware. */
  readonly objectives: readonly string[];
  /** Header text prepended to the todo block. Default: "## Current Objectives" */
  readonly header?: string;
  /** Called when an objective item is marked complete. */
  readonly onComplete?: (item: TodoItem) => void;
}

export function validateGoalAnchorConfig(config: unknown): Result<GoalAnchorConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalAnchorConfig must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = config as Record<string, unknown>;

  if (!Array.isArray(c.objectives)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalAnchorConfig.objectives must be an array of strings",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  for (const obj of c.objectives as unknown[]) {
    if (typeof obj !== "string") {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: "GoalAnchorConfig.objectives must be an array of strings",
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  if (c.header !== undefined && typeof c.header !== "string") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalAnchorConfig.header must be a string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.onComplete !== undefined && typeof c.onComplete !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalAnchorConfig.onComplete must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: config as GoalAnchorConfig };
}

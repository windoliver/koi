/**
 * GoalReminderConfig and validation for @koi/middleware-goal-reminder.
 */

import type { KoiError, Result } from "@koi/core/errors";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import type { TurnContext } from "@koi/core/middleware";
import type { ReminderSource } from "./types.js";

export interface GoalReminderConfig {
  /** Required: sources of reminder content. Must be non-empty. */
  readonly sources: readonly ReminderSource[];
  /** Base interval between reminders in turns. Must be >= 1. Default: 5. */
  readonly baseInterval: number;
  /** Maximum interval between reminders. Must be >= baseInterval. Default: 20. */
  readonly maxInterval: number;
  /** Custom drift detector. Defaults to keyword-based detection. */
  readonly isDrifting?: (ctx: TurnContext) => boolean | Promise<boolean>;
  /** Header text for the reminder block. Default: "Reminder". */
  readonly header?: string;
}

const VALID_SOURCE_KINDS: ReadonlySet<string> = new Set(["manifest", "static", "dynamic", "tasks"]);

function validationError(message: string): Result<GoalReminderConfig, KoiError> {
  return {
    ok: false,
    error: {
      code: "VALIDATION",
      message,
      retryable: RETRYABLE_DEFAULTS.VALIDATION,
    },
  };
}

function isValidSource(source: unknown): boolean {
  if (source === null || source === undefined || typeof source !== "object") {
    return false;
  }
  const s = source as Record<string, unknown>;
  if (typeof s.kind !== "string" || !VALID_SOURCE_KINDS.has(s.kind)) {
    return false;
  }
  switch (s.kind) {
    case "manifest":
      return (
        Array.isArray(s.objectives) && s.objectives.every((o: unknown) => typeof o === "string")
      );
    case "static":
      return typeof s.text === "string";
    case "dynamic":
      return typeof s.fetch === "function";
    case "tasks":
      return typeof s.provider === "function";
    default:
      return false;
  }
}

export function validateGoalReminderConfig(config: unknown): Result<GoalReminderConfig, KoiError> {
  if (config === null || config === undefined || typeof config !== "object") {
    return validationError("GoalReminderConfig must be a non-null object");
  }

  const c = config as Record<string, unknown>;

  // sources: non-empty array of valid ReminderSource
  if (!Array.isArray(c.sources) || c.sources.length === 0) {
    return validationError(
      "GoalReminderConfig.sources must be a non-empty array of ReminderSource",
    );
  }

  for (const source of c.sources as unknown[]) {
    if (!isValidSource(source)) {
      return validationError(
        "GoalReminderConfig.sources contains an invalid ReminderSource — each must have a valid kind (manifest, static, dynamic, tasks) with matching fields",
      );
    }
  }

  // baseInterval: finite positive integer >= 1
  if (
    typeof c.baseInterval !== "number" ||
    !Number.isFinite(c.baseInterval) ||
    !Number.isInteger(c.baseInterval) ||
    c.baseInterval < 1
  ) {
    return validationError("GoalReminderConfig.baseInterval must be a finite integer >= 1");
  }

  // maxInterval: finite positive integer >= baseInterval
  if (
    typeof c.maxInterval !== "number" ||
    !Number.isFinite(c.maxInterval) ||
    !Number.isInteger(c.maxInterval) ||
    c.maxInterval < c.baseInterval
  ) {
    return validationError(
      "GoalReminderConfig.maxInterval must be a finite integer >= baseInterval",
    );
  }

  // isDrifting: optional function
  if (c.isDrifting !== undefined && typeof c.isDrifting !== "function") {
    return validationError("GoalReminderConfig.isDrifting must be a function if provided");
  }

  // header: optional string
  if (c.header !== undefined && typeof c.header !== "string") {
    return validationError("GoalReminderConfig.header must be a string if provided");
  }

  return { ok: true, value: config as GoalReminderConfig };
}

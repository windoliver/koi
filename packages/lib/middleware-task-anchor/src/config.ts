/**
 * Task-anchor middleware configuration and validation.
 */

import type { KoiError, Result, SessionId, TaskBoard } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/** Accessor for the live TaskBoard snapshot of a session. Returns `undefined` when the session has no board. */
export type TaskBoardAccessor = (
  sessionId: SessionId,
) => TaskBoard | undefined | Promise<TaskBoard | undefined>;

/** Predicate identifying which tool ids count as "task activity". Resets the idle counter. */
export type TaskToolPredicate = (toolId: string) => boolean;

export interface TaskAnchorConfig {
  /** Live task-board accessor per session. */
  readonly getBoard: TaskBoardAccessor;
  /** K — idle turns before re-anchor fires. Default: 3. */
  readonly idleTurnThreshold?: number | undefined;
  /** Predicate for task-activity tool ids. Default: `toolId.startsWith("task_")`. */
  readonly isTaskTool?: TaskToolPredicate | undefined;
  /** When true, nudge model to call `task_create` once the board is empty AND tool activity was seen. Default: true. */
  readonly nudgeOnEmptyBoard?: boolean | undefined;
  /** Header text inside the system-reminder block. Default: `"Current tasks"`. */
  readonly header?: string | undefined;
}

export const DEFAULT_IDLE_TURN_THRESHOLD = 3;
export const DEFAULT_HEADER = "Current tasks";

export function defaultIsTaskTool(toolId: string): boolean {
  return toolId.startsWith("task_");
}

export function validateTaskAnchorConfig(input: unknown): Result<TaskAnchorConfig, KoiError> {
  if (input === null || input === undefined || typeof input !== "object") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TaskAnchorConfig must be a non-null object",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  const c = input as Record<string, unknown>;

  if (typeof c.getBoard !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TaskAnchorConfig.getBoard must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (
    c.idleTurnThreshold !== undefined &&
    (typeof c.idleTurnThreshold !== "number" ||
      !Number.isInteger(c.idleTurnThreshold) ||
      c.idleTurnThreshold < 1)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TaskAnchorConfig.idleTurnThreshold must be a positive integer",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.isTaskTool !== undefined && typeof c.isTaskTool !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TaskAnchorConfig.isTaskTool must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.nudgeOnEmptyBoard !== undefined && typeof c.nudgeOnEmptyBoard !== "boolean") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TaskAnchorConfig.nudgeOnEmptyBoard must be a boolean",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.header !== undefined && (typeof c.header !== "string" || c.header.length === 0)) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TaskAnchorConfig.header must be a non-empty string",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input as TaskAnchorConfig };
}

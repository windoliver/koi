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
  /**
   * Predicate for tool ids that count as "task board activity" — resets the
   * idle counter when successfully invoked. Includes both reads and writes
   * because either indicates the model is engaged with the board.
   * Default: `toolId.startsWith("task_")`.
   */
  readonly isTaskTool?: TaskToolPredicate | undefined;
  /**
   * Predicate for tool ids that *mutate* the board. Must be a subset of
   * `isTaskTool`. Only mutations drive the stop-gate rollback path that
   * suppresses the empty-board nudge on the retry turn (since read-only
   * calls cannot have completed or created work).
   * Default: a curated list matching `@koi/task-tools` mutating tools.
   */
  readonly isMutatingTaskTool?: TaskToolPredicate | undefined;
  /** When true, nudge model to call `task_create` once the board is empty AND tool activity was seen. Default: true. */
  readonly nudgeOnEmptyBoard?: boolean | undefined;
  /** Header text inside the system-reminder block. Default: `"Current tasks"`. */
  readonly header?: string | undefined;
  /** Max rendered tasks per reminder. Extras are collapsed into `… N more tasks`.
   *  Default: 50. Guards against prompt-budget blowup when a long-running
   *  coordinator session accumulates hundreds of tasks and the middleware
   *  re-injects on every idle turn. */
  readonly maxTasksInReminder?: number | undefined;
}

export const DEFAULT_IDLE_TURN_THRESHOLD = 3;
export const DEFAULT_HEADER = "Current tasks";
export const DEFAULT_MAX_TASKS_IN_REMINDER = 50;

export function defaultIsTaskTool(toolId: string): boolean {
  return toolId.startsWith("task_");
}

/**
 * Best-effort snapshot of `@koi/task-tools` mutating tool names. Kept in sync
 * manually because L2 packages cannot import each other — a direct import would
 * be a layer violation. If you add a new mutating task tool upstream, update
 * this list or — recommended — pass an explicit `isMutatingTaskTool` predicate
 * derived from the actual registered tool descriptors.
 *
 * An unknown mutating tool that is NOT in this set will still match `isTaskTool`
 * (and reset idle), but won't latch the stop-gate empty-board suppression —
 * which means a blocked retry could push a generic `task_create` nudge even
 * though real work was created. Explicit predicates are the safe default for
 * any caller wiring a custom task-tool surface.
 */
const MUTATING_TASK_TOOLS: ReadonlySet<string> = new Set([
  "task_create",
  "task_update",
  "task_delegate",
  "task_stop",
]);

/** Matches `@koi/task-tools` mutating tools only. `task_get`/`task_list`/`task_output` are excluded. */
export function defaultIsMutatingTaskTool(toolId: string): boolean {
  return MUTATING_TASK_TOOLS.has(toolId);
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

  if (c.isMutatingTaskTool !== undefined && typeof c.isMutatingTaskTool !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "TaskAnchorConfig.isMutatingTaskTool must be a function",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  // Custom `isTaskTool` without `isMutatingTaskTool` is accepted for backward
  // compatibility. The default mutating predicate still applies in that case
  // and will NOT recognize custom mutating tool names — so callers extending
  // the task-tool surface with mutating tools SHOULD pass `isMutatingTaskTool`
  // explicitly. Not doing so only means stop-gate rollback protection is
  // best-effort for custom tools; task-anchor still functions otherwise.
  // (See docs/L2/middleware-task-anchor.md for wiring guidance.)

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

  if (
    c.maxTasksInReminder !== undefined &&
    (typeof c.maxTasksInReminder !== "number" ||
      !Number.isInteger(c.maxTasksInReminder) ||
      c.maxTasksInReminder < 0)
  ) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message:
          "TaskAnchorConfig.maxTasksInReminder must be a non-negative integer (0 disables the cap)",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  return { ok: true, value: input as TaskAnchorConfig };
}

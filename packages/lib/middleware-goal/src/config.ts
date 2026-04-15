/**
 * Goal middleware configuration and validation.
 */

import type { KoiError, KoiMiddleware, Result, SessionId, TurnContext, TurnId } from "@koi/core";
import { RETRYABLE_DEFAULTS } from "@koi/core";

/** Lightweight goal state used by the exported pure helpers. */
export interface GoalItem {
  readonly text: string;
  readonly completed: boolean;
}

/** Goal item with a stable session-lifetime ID. Used by callback APIs. */
export interface GoalItemWithId extends GoalItem {
  /** Stable ID assigned at session start (e.g. `goal-0`). Safe to use as merge key. */
  readonly id: string;
}

/**
 * Redacted user-message view passed to the `isDrifting` callback.
 *
 * This is a purpose-built DTO — NOT a full `InboundMessage`. Only the
 * subset of fields safe to expose across the external-callback trust
 * boundary is included. File/image/tool content blocks, `threadId`,
 * `metadata`, and `pinned` are all intentionally omitted so they cannot
 * be exfiltrated to LLM-backed judges.
 */
export interface DriftUserMessage {
  readonly senderId: string;
  readonly timestamp: number;
  readonly text: string;
}

/** Input passed to a custom `isDrifting` callback. */
export interface DriftJudgeInput {
  /**
   * Last-N user-authored messages reduced to text content. Synthetic
   * stop-gate retry messages, non-user senders, and messages with
   * `metadata.role !== "user"` are filtered out; non-text content
   * blocks are dropped.
   */
  readonly userMessages: readonly DriftUserMessage[];
  /** Per-model-call assistant responses buffered during the turn. */
  readonly responseTexts: readonly string[];
  /** Current goal state with stable IDs. */
  readonly items: readonly GoalItemWithId[];
}

/**
 * User-supplied drift judge. Returns true if the agent is drifting from
 * the objectives based on recent activity. May be async (e.g. LLM judge).
 * MUST honor `ctx.signal` to stop in-flight work when it aborts.
 */
export type IsDriftingFn = (input: DriftJudgeInput, ctx: TurnContext) => boolean | Promise<boolean>;

/**
 * User-supplied completion detector. Invoked once per turn at
 * `onAfterTurn` with the per-model-call response texts buffered during
 * the turn. Must return the IDs of items that are newly-completed
 * (callback cannot un-complete items — completion is monotonic).
 *
 * The callback SHOULD evaluate each text independently to avoid
 * cross-call keyword aggregation. MUST honor `ctx.signal` to stop
 * in-flight work when it aborts.
 *
 * ⚠️ Providing this callback CHANGES `onComplete` timing: it fires
 * once per turn at turn boundary instead of synchronously per
 * model call. See `onComplete` JSDoc.
 */
export type DetectCompletionsFn = (
  responseTexts: readonly string[],
  items: readonly GoalItemWithId[],
  ctx: TurnContext,
) => readonly string[] | Promise<readonly string[]>;

/** Observability hook fired when a custom callback errors or times out. */
export type OnCallbackErrorFn = (info: {
  readonly callback: "isDrifting" | "detectCompletions";
  readonly reason: "error" | "timeout";
  readonly error?: unknown;
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
}) => void;

export interface GoalMiddlewareConfig {
  /** Objective strings to track. At least one required. */
  readonly objectives: readonly string[];
  /** Header text for the injected goal message. Default: "## Active Goals". */
  readonly header?: string | undefined;
  /** Turns between goal reminders. Default: 5. */
  readonly baseInterval?: number | undefined;
  /** Maximum interval between reminders. Default: 20. */
  readonly maxInterval?: number | undefined;
  /**
   * Called when an objective is marked completed.
   *
   * Timing depends on `detectCompletions`:
   * - No `detectCompletions` (default): fires synchronously inside the
   *   `wrapModelCall`/`wrapModelStream` that produced the detection.
   * - With `detectCompletions`: fires once per turn in `onAfterTurn`
   *   after the custom callback resolves. If the turn never reaches
   *   `onAfterTurn` (crash, cancellation), `onComplete` is skipped for
   *   detections from that turn.
   */
  readonly onComplete?: ((objective: string) => void) | undefined;
  /**
   * Custom drift judge. When provided, replaces the built-in keyword
   * heuristic for drift detection. See `IsDriftingFn`.
   */
  readonly isDrifting?: IsDriftingFn;
  /**
   * Custom completion detector. When provided, replaces the built-in
   * keyword heuristic and MOVES completion evaluation from per-model-call
   * synchronous path to turn-end (`onAfterTurn`). See `DetectCompletionsFn`
   * and `onComplete` timing notes.
   */
  readonly detectCompletions?: DetectCompletionsFn;
  /**
   * Max ms any single callback may run before it is aborted and fails
   * closed. Applied per callback invocation. Must be a finite positive
   * integer <= 60000. Default: 5000.
   */
  readonly callbackTimeoutMs?: number;
  /** Observability hook fired on callback error/timeout. */
  readonly onCallbackError?: OnCallbackErrorFn;
}

/**
 * Controller for mid-session goal management. Returned alongside the
 * KoiMiddleware by `createGoalMiddleware`. Allows TUI commands like
 * `/goal add <text>` and `/goal remove <text>` to modify objectives
 * without restarting the session.
 */
export interface GoalController {
  /** Add a new objective. Returns the assigned goal ID. No-op if text already exists. */
  readonly add: (text: string) => string | undefined;
  /** Remove an objective by text (exact match). Returns true if found and removed. */
  readonly remove: (text: string) => boolean;
  /** List all current objectives with their status. */
  readonly list: () => readonly GoalItemWithId[];
  /** Remove all objectives. */
  readonly clear: () => void;
}

/** Return type of createGoalMiddleware — middleware + controller for runtime access. */
export interface GoalMiddlewareWithController {
  readonly middleware: KoiMiddleware;
  readonly controller: GoalController;
}

export const DEFAULT_GOAL_HEADER = "## Active Goals";
export const DEFAULT_BASE_INTERVAL = 5;
export const DEFAULT_MAX_INTERVAL = 20;
export const DEFAULT_CALLBACK_TIMEOUT_MS = 5000;
export const MAX_CALLBACK_TIMEOUT_MS = 60000;

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

  // Validate relationship: maxInterval must be >= baseInterval
  const effectiveBase = typeof c.baseInterval === "number" ? c.baseInterval : DEFAULT_BASE_INTERVAL;
  const effectiveMax = typeof c.maxInterval === "number" ? c.maxInterval : DEFAULT_MAX_INTERVAL;
  if (effectiveMax < effectiveBase) {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: `GoalMiddlewareConfig.maxInterval (${String(effectiveMax)}) must be >= baseInterval (${String(effectiveBase)})`,
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.isDrifting !== undefined && typeof c.isDrifting !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalMiddlewareConfig.isDrifting must be a function if provided",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.detectCompletions !== undefined && typeof c.detectCompletions !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalMiddlewareConfig.detectCompletions must be a function if provided",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.onCallbackError !== undefined && typeof c.onCallbackError !== "function") {
    return {
      ok: false,
      error: {
        code: "VALIDATION",
        message: "GoalMiddlewareConfig.onCallbackError must be a function if provided",
        retryable: RETRYABLE_DEFAULTS.VALIDATION,
      },
    };
  }

  if (c.callbackTimeoutMs !== undefined) {
    const t = c.callbackTimeoutMs;
    if (
      typeof t !== "number" ||
      !Number.isFinite(t) ||
      !Number.isInteger(t) ||
      t < 1 ||
      t > MAX_CALLBACK_TIMEOUT_MS
    ) {
      return {
        ok: false,
        error: {
          code: "VALIDATION",
          message: `GoalMiddlewareConfig.callbackTimeoutMs must be a finite positive integer <= ${String(MAX_CALLBACK_TIMEOUT_MS)}`,
          retryable: RETRYABLE_DEFAULTS.VALIDATION,
        },
      };
    }
  }

  return { ok: true, value: input as GoalMiddlewareConfig };
}

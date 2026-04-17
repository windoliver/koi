/**
 * Task-anchor middleware — re-anchors the model on the live task board
 * after K idle turns with no task-tool activity.
 */

import type {
  CapabilityFragment,
  InboundMessage,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  SessionContext,
  SessionId,
  TaskBoard,
  TurnContext,
} from "@koi/core";
import { KoiRuntimeError, swallowError } from "@koi/errors";

import {
  DEFAULT_HEADER,
  DEFAULT_IDLE_TURN_THRESHOLD,
  defaultIsMutatingTaskTool,
  defaultIsTaskTool,
  type TaskAnchorConfig,
  type TaskToolPredicate,
  validateTaskAnchorConfig,
} from "./config.js";
import { buildEmptyBoardNudge, buildTaskReminder, formatTaskList } from "./reminder-format.js";

interface SessionState {
  idle: number;
  sawAnyTool: boolean;
  /** Any successful task-related tool ran this turn (reads or mutations). Resets idle. */
  taskToolThisTurn: boolean;
  /** A *mutating* task tool ran successfully this turn. Drives rollback that suppresses empty-board nudge. */
  mutatingTaskToolThisTurn: boolean;
  shouldInject: boolean;
  /** Set inside wrapModelCall/Stream when a reminder was prepended this turn. */
  injectedThisTurn: boolean;
  /** Set inside wrapModelCall/Stream when the board was observed reachable-but-empty
   *  (no reminder injected). Consumed by onAfterTurn to decide whether to re-arm
   *  force flags if the turn was itself stop-blocked. */
  observedEmptyThisTurn: boolean;
  /** Pre-injection `idle` snapshot — used to roll back on stop-gate blocked turns. */
  previousIdle: number | undefined;
  /** Pre-turn `forceRequiresTasks` snapshot — restored on blocked rollback so the
   *  suppression latch survives a second stop-gate block of the retry turn. */
  previousForceRequiresTasks: boolean;
  /** Force injection on the very next turn regardless of `idle` (stop-gate rollback). */
  forceInjectNextTurn: boolean;
  /** Latched: suppress the empty-board nudge. Set whenever a mutating task call on a
   *  blocked turn may have left the board empty by completing work. Cleared only
   *  when the board is actually observed (empty or non-empty) on a successful
   *  non-blocked turn — prevents the middleware from ever nudging the model to
   *  recreate work it just finished, even across chains of blocked retries. */
  forceRequiresTasks: boolean;
}

function initialState(): SessionState {
  return {
    idle: 0,
    sawAnyTool: false,
    taskToolThisTurn: false,
    mutatingTaskToolThisTurn: false,
    shouldInject: false,
    injectedThisTurn: false,
    observedEmptyThisTurn: false,
    previousIdle: undefined,
    previousForceRequiresTasks: false,
    forceInjectNextTurn: false,
    forceRequiresTasks: false,
  };
}

function prepend(request: ModelRequest, msg: InboundMessage): ModelRequest {
  return { ...request, messages: [msg, ...request.messages] };
}

function reminderMessage(text: string): InboundMessage {
  return {
    senderId: "system:task-anchor",
    timestamp: Date.now(),
    content: [{ kind: "text", text }],
  };
}

type BoardResolution =
  | { readonly kind: "ok"; readonly board: TaskBoard }
  | { readonly kind: "none" }
  | { readonly kind: "error" };

/**
 * Resolve the live board for a session. Distinguishes three outcomes because
 * they drive different retry semantics:
 *   - `ok`    → board is reachable, proceed to pick reminder text
 *   - `none`  → accessor returned `undefined` per the documented contract
 *               ("no board for this session"). Not transient — clear force
 *               flags so we don't retry forever.
 *   - `error` → accessor threw. Treated as transient; keep force flags
 *               armed so the next turn retries.
 */
async function resolveBoard(
  getBoard: TaskAnchorConfig["getBoard"],
  sessionId: SessionId,
): Promise<BoardResolution> {
  try {
    const board = await getBoard(sessionId);
    return board === undefined ? { kind: "none" } : { kind: "ok", board };
  } catch (e: unknown) {
    swallowError(e, { package: "@koi/middleware-task-anchor", operation: "getBoard" });
    return { kind: "error" };
  }
}

function isTaskToolSafely(predicate: TaskToolPredicate, toolId: string): boolean {
  try {
    return predicate(toolId);
  } catch (e: unknown) {
    swallowError(e, { package: "@koi/middleware-task-anchor", operation: "isTaskTool" });
    return false;
  }
}

/**
 * Decide which reminder (if any) to inject given the current board and session state.
 * Returns the reminder text, or `undefined` to skip. Caller must pass a reachable
 * board — transient `getBoard` failures are handled separately by wrapModelCall/Stream.
 *
 * When `forceRequiresTasks` is true (stop-gate rollback after successful task
 * mutation), we suppress the empty-board nudge: the blocked turn may have
 * completed the last task, and the retry must not push the model into
 * recreating work that just finished.
 */
function pickReminderText(
  board: TaskBoard,
  state: SessionState,
  header: string,
  nudgeOnEmptyBoard: boolean,
): string | undefined {
  const body = formatTaskList(board);
  if (body.length > 0) return buildTaskReminder(header, body);
  if (state.forceRequiresTasks) return undefined;
  if (nudgeOnEmptyBoard && state.sawAnyTool) return buildEmptyBoardNudge();
  return undefined;
}

export function createTaskAnchorMiddleware(config: TaskAnchorConfig): KoiMiddleware {
  const validated = validateTaskAnchorConfig(config);
  if (!validated.ok) {
    throw KoiRuntimeError.from(validated.error.code, validated.error.message);
  }

  const threshold = config.idleTurnThreshold ?? DEFAULT_IDLE_TURN_THRESHOLD;
  const isTaskTool = config.isTaskTool ?? defaultIsTaskTool;
  // `isMutatingTaskTool` always falls back to the curated default — regardless
  // of whether `isTaskTool` was overridden. Previously we tried inferring
  // mutation from `isTaskTool` when unspecified, but that misclassifies every
  // read-only custom tool (e.g., a custom `task_list_by_owner`) as mutating
  // and silently triggers empty-board suppression on stop-gate retries.
  // Callers with custom mutating tools MUST pass `isMutatingTaskTool`
  // explicitly — otherwise stop-gate rollback protection stays best-effort,
  // but behavior won't change for read-only custom tools.
  const isMutatingTaskTool = config.isMutatingTaskTool ?? defaultIsMutatingTaskTool;
  const nudgeOnEmptyBoard = config.nudgeOnEmptyBoard ?? true;
  const header = config.header ?? DEFAULT_HEADER;

  const sessions = new Map<SessionId, SessionState>();

  return {
    name: "task-anchor",
    priority: 345,

    describeCapabilities(ctx: TurnContext): CapabilityFragment | undefined {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return undefined;
      return {
        label: "task-anchor",
        description: `Idle ${String(state.idle)}/${String(threshold)} turns since last task activity`,
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId, initialState());
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return;
      // `shouldInject` is recomputed every turn; `forceInjectNextTurn` and
      // `forceRequiresTasks` persist until they drive an actual injection or
      // until the board is observed to have nothing to say (cleared in
      // wrapModelCall/Stream). A transient `getBoard` failure on a forced
      // retry keeps the flags alive so the NEXT turn tries again.
      state.shouldInject = state.forceInjectNextTurn || state.idle >= threshold;
      state.taskToolThisTurn = false;
      state.mutatingTaskToolThisTurn = false;
      state.injectedThisTurn = false;
      state.observedEmptyThisTurn = false;
      state.previousIdle = undefined;
      state.previousForceRequiresTasks = state.forceRequiresTasks;
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return;

      // Stop-gate blocked turn: the engine rebuilds the retry input from the
      // original user messages plus the block message — the blocked turn's
      // tool exchange and our injected reminder are both dropped. If either
      // piece of board-relevant context occurred this turn, force re-inject
      // on the retry AND restore the pre-injection idle counter so the retry
      // sees the same cadence state as before this turn ran.
      if (ctx.stopBlocked === true) {
        // A *mutating* task tool ran: the retry input drops the tool exchange,
        // and the blocked turn may have completed the last task. Latch
        // `forceRequiresTasks` so the empty-board nudge stays suppressed across
        // the retry chain.
        if (state.mutatingTaskToolThisTurn) {
          if (state.previousIdle !== undefined) state.idle = state.previousIdle;
          state.forceInjectNextTurn = true;
          state.forceRequiresTasks = true;
          return;
        }
        // Read-only task activity, injected-only, OR empty-observed-only:
        // re-arm the retry force flag AND restore the pre-turn
        // `forceRequiresTasks` snapshot. `wrapModelCall` may have cleared the
        // latch at observation/injection time, but a stop-gate block of that
        // retry invalidates the clear — restoration keeps the suppression
        // invariant across arbitrary chains of blocked retries.
        if (state.taskToolThisTurn || state.injectedThisTurn || state.observedEmptyThisTurn) {
          if (state.previousIdle !== undefined) state.idle = state.previousIdle;
          state.forceInjectNextTurn = true;
          state.forceRequiresTasks = state.previousForceRequiresTasks;
          return;
        }
        // Blocked turn with no board-relevant activity: advance `idle` the
        // same as a normal turn so repeated stop-gate loops still escalate
        // toward a reminder at threshold. Do NOT touch `forceRequiresTasks`.
        state.idle += 1;
        return;
      }

      // Non-blocked turn. Do NOT touch `forceRequiresTasks` here: its lifetime
      // is controlled by wrapModelCall/Stream at the board-observation point,
      // so a transient `getBoard` failure cannot prematurely lift protection.

      // Task activity wins: the board changed, so idle resets regardless of
      // whether we also injected a now-stale reminder.
      if (state.taskToolThisTurn) {
        state.idle = 0;
        return;
      }

      // Injection committed `idle = 0` synchronously in wrapModelCall/Stream
      // so error paths that skip `onAfterTurn` still leave a clean state.
      // Nothing to commit here unless no injection happened.
      if (!state.injectedThisTurn) {
        state.idle += 1;
      }
    },

    async wrapModelCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state?.shouldInject || state.injectedThisTurn) return next(request);

      const result = await resolveBoard(config.getBoard, ctx.session.sessionId);
      if (result.kind === "error") {
        // Transient backend failure: keep force flags armed for the next turn.
        return next(request);
      }
      if (result.kind === "none") {
        // Documented "no board for this session" — not transient. Clear force
        // flags so we don't retry forever when the session genuinely has no board.
        state.forceInjectNextTurn = false;
        state.forceRequiresTasks = false;
        return next(request);
      }

      const text = pickReminderText(result.board, state, header, nudgeOnEmptyBoard);
      if (text === undefined) {
        // Board was observed and is empty (nudge suppressed by current state).
        // Clear the force flags so a non-blocked completion lifts protection,
        // but record `observedEmptyThisTurn` so `onAfterTurn` can re-arm
        // protection if this retry is itself stop-blocked.
        state.observedEmptyThisTurn = true;
        state.forceInjectNextTurn = false;
        state.forceRequiresTasks = false;
        return next(request);
      }

      // Board observed and has tasks — real anchor happening. Sync commit
      // `idle = 0` so error paths that skip `onAfterTurn` still leave a clean
      // state. Lift both force flags (protection successfully served). Rollback
      // for stop-gate retries is handled explicitly via `previousIdle`.
      state.previousIdle = state.idle;
      state.idle = 0;
      state.injectedThisTurn = true;
      state.forceInjectNextTurn = false;
      state.forceRequiresTasks = false;
      return next(prepend(request, reminderMessage(text)));
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId);
      if (!state?.shouldInject || state.injectedThisTurn) {
        yield* next(request);
        return;
      }

      const result = await resolveBoard(config.getBoard, ctx.session.sessionId);
      if (result.kind === "error") {
        yield* next(request);
        return;
      }
      if (result.kind === "none") {
        state.forceInjectNextTurn = false;
        state.forceRequiresTasks = false;
        yield* next(request);
        return;
      }

      const text = pickReminderText(result.board, state, header, nudgeOnEmptyBoard);
      if (text === undefined) {
        // See wrapModelCall — track empty observation for blocked-retry restore.
        state.observedEmptyThisTurn = true;
        state.forceInjectNextTurn = false;
        state.forceRequiresTasks = false;
        yield* next(request);
        return;
      }

      state.previousIdle = state.idle;
      state.idle = 0;
      state.injectedThisTurn = true;
      state.forceInjectNextTurn = false;
      state.forceRequiresTasks = false;
      yield* next(prepend(request, reminderMessage(text)));
    },

    async wrapToolCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      if (state) state.sawAnyTool = true;
      const response = await next(request);
      // Only flag task-tool activity AFTER a successful mutation. Two
      // failure modes must NOT mark the board as mutated:
      //   - Thrown exceptions (handled by the `await` above — this line
      //     never runs on throw)
      //   - Non-throwing `{ ok: false, error }` results returned by
      //     `@koi/task-tools` for schema/validation/rejected-update paths
      // Otherwise a rejected `task_create` on a stop-gated turn would
      // suppress the empty-board nudge on retry or silently reset idle
      // on a normal turn.
      if (state && isTaskToolSafely(isTaskTool, request.toolId)) {
        // A tool call is a successful mutation signal only when:
        //   - `next()` didn't throw (we're past the await)
        //   - output is not `{ ok: false }` (task-tools validation failure shape)
        //   - `response.metadata.blockedByHook !== true` (hook-veto contract)
        const out = response.output;
        const explicitFailure =
          out !== null &&
          typeof out === "object" &&
          "ok" in out &&
          (out as { ok: unknown }).ok === false;
        const hookBlocked = response.metadata?.blockedByHook === true;
        if (!explicitFailure && !hookBlocked) {
          state.taskToolThisTurn = true;
          if (isTaskToolSafely(isMutatingTaskTool, request.toolId)) {
            state.mutatingTaskToolThisTurn = true;
          }
        }
      }
      return response;
    },
  };
}

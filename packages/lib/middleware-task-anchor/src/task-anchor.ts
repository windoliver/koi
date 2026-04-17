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
  defaultIsTaskTool,
  type TaskAnchorConfig,
  type TaskToolPredicate,
  validateTaskAnchorConfig,
} from "./config.js";
import { buildEmptyBoardNudge, buildTaskReminder, formatTaskList } from "./reminder-format.js";

interface SessionState {
  idle: number;
  sawAnyTool: boolean;
  taskToolThisTurn: boolean;
  shouldInject: boolean;
}

function initialState(): SessionState {
  return { idle: 0, sawAnyTool: false, taskToolThisTurn: false, shouldInject: false };
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

async function resolveBoard(
  getBoard: TaskAnchorConfig["getBoard"],
  sessionId: SessionId,
): Promise<TaskBoard | undefined> {
  try {
    return await getBoard(sessionId);
  } catch (e: unknown) {
    swallowError(e, { package: "@koi/middleware-task-anchor", operation: "getBoard" });
    return undefined;
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
 * Returns the reminder text, or `undefined` to skip.
 */
function pickReminderText(
  board: TaskBoard | undefined,
  state: SessionState,
  header: string,
  nudgeOnEmptyBoard: boolean,
): string | undefined {
  if (!board) return undefined;
  const body = formatTaskList(board);
  if (body.length > 0) return buildTaskReminder(header, body);
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
      state.shouldInject = state.idle >= threshold;
      state.taskToolThisTurn = false;
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const state = sessions.get(ctx.session.sessionId);
      if (!state) return;
      if (state.taskToolThisTurn) {
        state.idle = 0;
      } else {
        state.idle += 1;
      }
    },

    async wrapModelCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      if (!state?.shouldInject) return next(request);

      const board = await resolveBoard(config.getBoard, ctx.session.sessionId);
      const text = pickReminderText(board, state, header, nudgeOnEmptyBoard);
      if (text === undefined) return next(request);

      state.shouldInject = false;
      state.idle = 0;
      return next(prepend(request, reminderMessage(text)));
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId);
      if (!state?.shouldInject) {
        yield* next(request);
        return;
      }

      const board = await resolveBoard(config.getBoard, ctx.session.sessionId);
      const text = pickReminderText(board, state, header, nudgeOnEmptyBoard);
      if (text === undefined) {
        yield* next(request);
        return;
      }

      state.shouldInject = false;
      state.idle = 0;
      yield* next(prepend(request, reminderMessage(text)));
    },

    async wrapToolCall(ctx, request, next) {
      const state = sessions.get(ctx.session.sessionId);
      if (state) {
        state.sawAnyTool = true;
        if (isTaskToolSafely(isTaskTool, request.toolId)) {
          state.taskToolThisTurn = true;
        }
      }
      return next(request);
    },
  };
}

/**
 * Two-stage turn acknowledgement: debounced "processing" + "idle" via
 * channel.sendStatus. All sendStatus calls are fire-and-forget; rejections
 * surface only through the configured onError callback and never propagate.
 *
 * Optimization-only: never modifies requests, responses, or stop conditions.
 */

import type {
  CapabilityFragment,
  ChannelStatus,
  KoiMiddleware,
  SessionContext,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";

const DEFAULT_DEBOUNCE_MS = 100;
const MIDDLEWARE_PRIORITY = 50;

export interface TurnAckScheduler {
  readonly setTimeout: (handler: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

export interface TurnAckConfig {
  /** Debounce window before "processing" fires. Default: 100ms. */
  readonly debounceMs?: number;
  /** Emit per-tool "processing" status from wrapToolCall. Default: true. */
  readonly toolStatus?: boolean;
  /** Callback for swallowed sendStatus rejections. Default: console.warn. */
  readonly onError?: (e: unknown) => void;
  /** Scheduler injection for deterministic tests. Default: globals. */
  readonly scheduler?: TurnAckScheduler;
}

const GLOBAL_SCHEDULER: TurnAckScheduler = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

/**
 * Invoke a status sender and route any failure (sync throw or async rejection)
 * through `onError`. Synchronous throws inside `send` would otherwise escape
 * past a `.catch()` on the returned Promise.
 */
function fireAndForget(send: () => Promise<void>, onError: (e: unknown) => void): void {
  let promise: Promise<void> | undefined;
  try {
    promise = send();
  } catch (e: unknown) {
    onError(e);
    return;
  }
  if (promise === undefined) return;
  promise.catch((e: unknown) => onError(e));
}

interface TurnAckState {
  readonly debounceMs: number;
  readonly toolStatus: boolean;
  readonly onError: (e: unknown) => void;
  readonly scheduler: TurnAckScheduler;
  readonly pending: Map<string, unknown>;
}

function clearPending(state: TurnAckState, sessionId: string): void {
  const handle = state.pending.get(sessionId);
  if (handle !== undefined) {
    state.scheduler.clearTimeout(handle);
    state.pending.delete(sessionId);
  }
}

function emitStatus(state: TurnAckState, ctx: TurnContext, status: ChannelStatus): void {
  if (ctx.sendStatus === undefined) return;
  const send = ctx.sendStatus;
  fireAndForget(() => send(status), state.onError);
}

async function handleBeforeTurn(state: TurnAckState, ctx: TurnContext): Promise<void> {
  if (ctx.sendStatus === undefined) return;
  const sid = ctx.session.sessionId as unknown as string;
  const sendStatus = ctx.sendStatus;
  const turnIndex = ctx.turnIndex;
  clearPending(state, sid);
  const handle = state.scheduler.setTimeout(() => {
    state.pending.delete(sid);
    fireAndForget(() => sendStatus({ kind: "processing", turnIndex }), state.onError);
  }, state.debounceMs);
  state.pending.set(sid, handle);
}

async function handleAfterTurn(state: TurnAckState, ctx: TurnContext): Promise<void> {
  const sid = ctx.session.sessionId as unknown as string;
  clearPending(state, sid);
  emitStatus(state, ctx, { kind: "idle", turnIndex: ctx.turnIndex });
}

async function handleToolCall(
  state: TurnAckState,
  ctx: TurnContext,
  request: ToolRequest,
  next: ToolHandler,
): Promise<ToolResponse> {
  if (state.toolStatus) {
    emitStatus(state, ctx, {
      kind: "processing",
      turnIndex: ctx.turnIndex,
      detail: `calling ${request.toolId}`,
    });
  }
  return next(request);
}

function buildCapabilityFragment(state: TurnAckState): CapabilityFragment {
  return {
    label: "turn-ack",
    description:
      `Turn status: processing after ${String(state.debounceMs)}ms, idle on completion` +
      (state.toolStatus ? ", per-tool status" : ""),
  };
}

export function createTurnAckMiddleware(config?: TurnAckConfig): KoiMiddleware {
  const state: TurnAckState = {
    debounceMs: config?.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    toolStatus: config?.toolStatus ?? true,
    onError: config?.onError ?? ((e: unknown) => console.warn("turn-ack: sendStatus failed", e)),
    scheduler: config?.scheduler ?? GLOBAL_SCHEDULER,
    pending: new Map<string, unknown>(),
  };
  const capability = buildCapabilityFragment(state);

  return {
    name: "turn-ack",
    priority: MIDDLEWARE_PRIORITY,
    phase: "resolve",
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capability,
    onBeforeTurn: (ctx) => handleBeforeTurn(state, ctx),
    onAfterTurn: (ctx) => handleAfterTurn(state, ctx),
    onSessionEnd: async (ctx: SessionContext) => {
      clearPending(state, ctx.sessionId as unknown as string);
    },
    wrapToolCall: (ctx, req, next) => handleToolCall(state, ctx, req, next),
  };
}

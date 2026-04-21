/**
 * Debug middleware — KoiMiddleware with controller interface.
 *
 * When inactive: zero overhead (early return).
 * When active: records engine events, evaluates breakpoints, gates execution on hit.
 */

import type {
  Breakpoint,
  BreakpointId,
  BreakpointOptions,
  BreakpointPredicate,
  DebugEvent,
  DebugSessionId,
  EngineEvent,
  KoiError,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  Result,
  ToolCallId,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { breakpointId, toolCallId } from "@koi/core";
import { matchesBreakpoint } from "./breakpoint-matcher.js";
import { DEBUG_MIDDLEWARE_NAME, DEBUG_MIDDLEWARE_PRIORITY } from "./constants.js";
import type { EventRingBuffer } from "./event-ring-buffer.js";
import type { BreakpointEntry, GateControl } from "./types.js";
import { createGate } from "./types.js";

// ---------------------------------------------------------------------------
// Controller interface (used by DebugSession)
// ---------------------------------------------------------------------------

export interface DebugController {
  readonly isActive: () => boolean;
  readonly activate: () => void;
  readonly deactivate: () => void;
  readonly addBreakpoint: (
    predicate: BreakpointPredicate,
    options?: BreakpointOptions,
  ) => Result<Breakpoint, KoiError>;
  readonly removeBreakpoint: (id: BreakpointId) => boolean;
  readonly breakpoints: () => readonly Breakpoint[];
  readonly releaseGate: () => void;
  readonly isPaused: () => boolean;
  readonly turnIndex: () => number;
  readonly onDebugEvent: (listener: (event: DebugEvent) => void) => () => void;
  readonly eventBuffer: () => EventRingBuffer;
  readonly pausedEvent: () => EngineEvent | undefined;
  readonly pausedBreakpointId: () => BreakpointId | undefined;
  readonly setSessionId: (id: DebugSessionId) => void;
}

export interface DebugMiddlewareResult {
  readonly middleware: KoiMiddleware;
  readonly controller: DebugController;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDebugMiddleware(
  eventBuffer: EventRingBuffer,
  sessionId?: DebugSessionId,
): DebugMiddlewareResult {
  // let justified: mutable state — all changes scoped to this closure
  let debugSessId: DebugSessionId = sessionId ?? ("" as DebugSessionId);
  let active = false;
  let gate: GateControl | undefined;
  let paused = false;
  let pausedEvt: EngineEvent | undefined;
  let pausedBpId: BreakpointId | undefined;
  let currentTurnIndex = 0;
  let bpCounter = 0;

  const breakpointMap = new Map<string, BreakpointEntry>();
  const debugListeners = new Set<(event: DebugEvent) => void>();

  function emitDebugEvent(event: DebugEvent): void {
    for (const listener of debugListeners) {
      try {
        listener(event);
      } catch {
        // Listener errors must never propagate into the debugged execution path
      }
    }
  }

  async function processEvent(event: EngineEvent): Promise<void> {
    eventBuffer.push(event);

    if (event.kind === "turn_start") {
      currentTurnIndex = event.turnIndex;
    }

    for (const [id, bp] of breakpointMap) {
      try {
        if (matchesBreakpoint(bp.predicate, { event, turnIndex: currentTurnIndex })) {
          const bpId = bp.id;

          if (bp.once) {
            breakpointMap.delete(id);
          }

          emitDebugEvent({
            kind: "breakpoint_hit",
            debugSessionId: debugSessId,
            breakpointId: bpId,
            turnIndex: currentTurnIndex,
            event,
          });

          gate = createGate();
          paused = true;
          pausedEvt = event;
          pausedBpId = bpId;

          emitDebugEvent({
            kind: "paused",
            debugSessionId: debugSessId,
            breakpointId: bpId,
            turnIndex: currentTurnIndex,
          });

          await gate.promise;

          paused = false;
          pausedEvt = undefined;
          pausedBpId = undefined;
          gate = undefined;

          emitDebugEvent({ kind: "resumed", debugSessionId: debugSessId });

          // Only hit one breakpoint per event
          break;
        }
      } catch {
        // Predicate error — remove breakpoint, agent continues
        breakpointMap.delete(id);
      }
    }
  }

  const middleware: KoiMiddleware = {
    name: DEBUG_MIDDLEWARE_NAME,
    priority: DEBUG_MIDDLEWARE_PRIORITY,

    describeCapabilities: (): ReturnType<NonNullable<KoiMiddleware["describeCapabilities"]>> => {
      if (!active) return undefined;
      return {
        label: "debug",
        description: `Debug session active. ${String(breakpointMap.size)} breakpoint(s).`,
      };
    },

    onBeforeTurn: async (ctx: TurnContext): Promise<void> => {
      if (!active) return;
      await processEvent({ kind: "turn_start", turnIndex: ctx.turnIndex });
    },

    onAfterTurn: async (ctx: TurnContext): Promise<void> => {
      if (!active) return;
      await processEvent({ kind: "turn_end", turnIndex: ctx.turnIndex });
    },

    wrapToolCall: async (
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> => {
      if (!active) return next(request);

      const callId: ToolCallId = toolCallId(request.callId ?? crypto.randomUUID());

      await processEvent({ kind: "tool_call_start", toolName: request.toolId, callId });
      try {
        const response = await next(request);
        await processEvent({ kind: "tool_call_end", callId, result: response.output });
        await processEvent({ kind: "tool_result", callId, output: response.output });
        return response;
      } catch (e: unknown) {
        await processEvent({
          kind: "custom",
          type: "tool_call_error",
          data: { callId: callId as string, error: String(e) },
        });
        throw e;
      }
    },

    wrapModelCall: async (
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> => {
      if (!active) return next(request);

      await processEvent({ kind: "custom", type: "model_call_start", data: undefined });
      try {
        const response = await next(request);
        await processEvent({ kind: "custom", type: "model_call_end", data: undefined });
        return response;
      } catch (e: unknown) {
        await processEvent({
          kind: "custom",
          type: "model_call_error",
          data: { error: String(e) },
        });
        throw e;
      }
    },

    wrapModelStream: async function* (
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      if (!active) {
        yield* next(request);
        return;
      }

      await processEvent({ kind: "custom", type: "model_call_start", data: undefined });
      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "text_delta") {
            await processEvent({ kind: "text_delta", delta: chunk.delta });
          }
          yield chunk;
        }
        await processEvent({ kind: "custom", type: "model_call_end", data: undefined });
      } catch (e: unknown) {
        await processEvent({
          kind: "custom",
          type: "model_call_error",
          data: { error: String(e) },
        });
        throw e;
      }
    },
  };

  const controller: DebugController = {
    isActive: () => active,
    activate: () => {
      active = true;
    },
    deactivate: () => {
      active = false;
      if (paused && gate !== undefined) {
        gate.release();
        paused = false;
        pausedEvt = undefined;
        pausedBpId = undefined;
        gate = undefined;
      }
    },

    addBreakpoint: (predicate, options): Result<Breakpoint, KoiError> => {
      if (predicate.kind === "error") {
        return {
          ok: false,
          error: {
            code: "VALIDATION",
            message:
              "error breakpoints are not supported: the debug middleware only observes " +
              "turn and tool-call lifecycle events. Use a turn or tool_call breakpoint instead.",
            retryable: false,
          },
        };
      }
      if (predicate.kind === "event_kind") {
        const OBSERVED_EVENT_KINDS = new Set([
          "turn_start",
          "turn_end",
          "tool_call_start",
          "tool_call_end",
          "tool_result",
          "text_delta",
          "custom",
        ]);
        if (!OBSERVED_EVENT_KINDS.has(predicate.eventKind)) {
          return {
            ok: false,
            error: {
              code: "VALIDATION",
              message:
                `event_kind breakpoints for "${predicate.eventKind}" are not supported: ` +
                `the debug middleware only observes: ${[...OBSERVED_EVENT_KINDS].join(", ")}.`,
              retryable: false,
            },
          };
        }
      }
      bpCounter += 1;
      const id = breakpointId(`bp-${String(bpCounter)}`);
      const entry: BreakpointEntry = {
        id,
        predicate,
        once: options?.once ?? false,
        label: options?.label,
      };
      breakpointMap.set(id as string, entry);
      return { ok: true, value: { id, predicate, once: entry.once, label: entry.label } };
    },

    removeBreakpoint: (id) => breakpointMap.delete(id as string),

    breakpoints: () =>
      [...breakpointMap.values()].map((bp) => ({
        id: bp.id,
        predicate: bp.predicate,
        once: bp.once,
        label: bp.label,
      })),

    releaseGate: () => {
      gate?.release();
    },

    isPaused: () => paused,
    turnIndex: () => currentTurnIndex,

    onDebugEvent: (listener) => {
      debugListeners.add(listener);
      return () => {
        debugListeners.delete(listener);
      };
    },

    eventBuffer: () => eventBuffer,
    pausedEvent: () => pausedEvt,
    pausedBreakpointId: () => pausedBpId,
    setSessionId: (sid) => {
      debugSessId = sid;
    },
  };

  return { middleware, controller };
}

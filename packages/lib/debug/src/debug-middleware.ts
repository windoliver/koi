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
import {
  DEBUG_MIDDLEWARE_NAME,
  DEBUG_MIDDLEWARE_PRIORITY,
  MAX_EVENT_PAYLOAD_BYTES,
} from "./constants.js";
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
    /** @internal Filter for `custom` event breakpoints (step-error catchpoints). */
    internalOptions?: { readonly customTypeFilter?: ReadonlySet<string> | undefined },
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
  /** Emit a debug event through the controller's event stream (reaches session + observer subscribers). */
  readonly emitEvent: (event: DebugEvent) => void;
}

export interface DebugMiddlewareResult {
  readonly middleware: KoiMiddleware;
  readonly controller: DebugController;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Bound the retained event payload to fixed-size metadata + shallow preview.
 * Never fully serializes arbitrary objects — callers who need full data should
 * use inspectComponent (which has proper pagination + structured cloning).
 */
function truncatePayload(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length <= MAX_EVENT_PAYLOAD_BYTES) return value;
    return `${value.slice(0, MAX_EVENT_PAYLOAD_BYTES)}…[truncated ${value.length - MAX_EVENT_PAYLOAD_BYTES} bytes]`;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return {
      __summary: "array",
      length: value.length,
      firstItemType: value.length > 0 ? typeof value[0] : undefined,
    };
  }
  const keys = Object.keys(value as Record<string, unknown>);
  return {
    __summary: "object",
    keyCount: keys.length,
    keys: keys.slice(0, 16),
  };
}

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
        if (!matchesBreakpoint(bp.predicate, { event, turnIndex: currentTurnIndex })) continue;
        // Additional custom-type filter for step()-injected error catchpoints
        if (bp.customTypeFilter !== undefined && event.kind === "custom") {
          if (!bp.customTypeFilter.has(event.type)) continue;
        }
        {
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

          const releasedForTeardown = !active;
          paused = false;
          pausedEvt = undefined;
          pausedBpId = undefined;
          gate = undefined;

          // Only emit "resumed" for genuine resume calls, not teardown-driven
          // gate releases. Observers that receive "detached" must not also
          // receive "resumed" after, which would falsely signal an active session.
          if (!releasedForTeardown) {
            emitDebugEvent({ kind: "resumed", debugSessionId: debugSessId });
          }

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
    // resolve phase runs AFTER intercept-tier security guards (permissions,
    // exfiltration). Debug sees only approved tool calls; denied calls are
    // rejected upstream before reaching the debugger.
    phase: "resolve",

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
        const truncatedOutput = truncatePayload(response.output);
        await processEvent({ kind: "tool_call_end", callId, result: truncatedOutput });
        await processEvent({ kind: "tool_result", callId, output: truncatedOutput });
        return response;
      } catch (e: unknown) {
        await processEvent({
          kind: "custom",
          type: "tool_call_error",
          data: { callId: callId as string, error: String(e).slice(0, MAX_EVENT_PAYLOAD_BYTES) },
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
          data: { error: String(e).slice(0, MAX_EVENT_PAYLOAD_BYTES) },
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
          // Surface every ModelChunk variant so operators can diagnose streaming
          // failure paths (malformed tool args, thinking stalls, usage overruns,
          // terminal done/error). Untyped chunks are preserved as custom events.
          if (chunk.kind === "text_delta") {
            await processEvent({
              kind: "text_delta",
              delta: truncatePayload(chunk.delta) as string,
            });
          } else if (chunk.kind === "thinking_delta") {
            await processEvent({
              kind: "custom",
              type: "thinking_delta",
              data: { delta: truncatePayload(chunk.delta) },
            });
          } else if (chunk.kind === "tool_call_start") {
            // Disambiguate: model-ANNOUNCED tool call (before execution) is a
            // custom event, so it does not double-fire tool_call breakpoints
            // alongside the runtime-EXECUTED tool_call_start from wrapToolCall.
            await processEvent({
              kind: "custom",
              type: "model_tool_call_announced",
              data: { toolName: chunk.toolName, callId: chunk.callId as string },
            });
          } else if (chunk.kind === "tool_call_delta") {
            await processEvent({
              kind: "custom",
              type: "tool_call_delta",
              data: { callId: chunk.callId as string, delta: truncatePayload(chunk.delta) },
            });
          } else if (chunk.kind === "tool_call_end") {
            // Model-ANNOUNCED tool_call_end (model finished emitting the call) —
            // custom event, not the same as wrapToolCall's execution tool_call_end.
            await processEvent({
              kind: "custom",
              type: "model_tool_call_emitted",
              data: { callId: chunk.callId as string },
            });
          } else if (chunk.kind === "usage") {
            await processEvent({
              kind: "custom",
              type: "model_usage",
              data: { inputTokens: chunk.inputTokens, outputTokens: chunk.outputTokens },
            });
          } else if (chunk.kind === "error") {
            await processEvent({
              kind: "custom",
              type: "model_stream_error",
              data: {
                message: String(chunk.message).slice(0, MAX_EVENT_PAYLOAD_BYTES),
                code: chunk.code,
                retryable: chunk.retryable ?? null,
              },
            });
          } else if (chunk.kind === "done") {
            await processEvent({ kind: "custom", type: "model_stream_done", data: undefined });
          }
          yield chunk;
        }
        await processEvent({ kind: "custom", type: "model_call_end", data: undefined });
      } catch (e: unknown) {
        await processEvent({
          kind: "custom",
          type: "model_call_error",
          data: { error: String(e).slice(0, MAX_EVENT_PAYLOAD_BYTES) },
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

    addBreakpoint: (predicate, options, internalOptions): Result<Breakpoint, KoiError> => {
      // Lenient acceptance: the public BreakpointPredicate contract in @koi/core
      // is broader than this middleware can honor (no done/error engine events,
      // no synthetic tool_result). Rather than rejecting unsupported predicates
      // and breaking type-level compatibility, we accept them and let the
      // matcher decide at event time. Unsupported predicates simply never fire.
      // Callers can check SUPPORTED_EVENT_KINDS to see which kinds this
      // middleware observes.
      bpCounter += 1;
      const id = breakpointId(`bp-${String(bpCounter)}`);
      const entry: BreakpointEntry = {
        id,
        predicate,
        once: options?.once ?? false,
        label: options?.label,
        customTypeFilter: internalOptions?.customTypeFilter,
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
    emitEvent: (event) => {
      emitDebugEvent(event);
    },
  };

  return { middleware, controller };
}

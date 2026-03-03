/**
 * Debug middleware — KoiMiddleware with controller interface.
 *
 * When inactive: zero overhead (early return).
 * When active: records events, evaluates breakpoints, gates execution on hit.
 */

import type {
  Breakpoint,
  BreakpointId,
  BreakpointOptions,
  BreakpointPredicate,
  DebugEvent,
  EngineEvent,
  KoiMiddleware,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { breakpointId } from "@koi/core";
import { matchesBreakpoint } from "./breakpoint-matcher.js";
import { DEBUG_MIDDLEWARE_NAME, DEBUG_MIDDLEWARE_PRIORITY } from "./constants.js";
import type { EventRingBuffer } from "./event-ring-buffer.js";
import type { BreakpointEntry, GateControl } from "./types.js";
import { createGate } from "./types.js";

// ---------------------------------------------------------------------------
// Controller interface (used by DebugSession)
// ---------------------------------------------------------------------------

export interface DebugController {
  /** Whether the debug middleware is currently active. */
  readonly isActive: () => boolean;
  /** Activate the middleware. */
  readonly activate: () => void;
  /** Deactivate the middleware and release any gate. */
  readonly deactivate: () => void;
  /** Register a breakpoint. */
  readonly addBreakpoint: (
    predicate: BreakpointPredicate,
    options?: BreakpointOptions,
  ) => Breakpoint;
  /** Remove a breakpoint by ID. */
  readonly removeBreakpoint: (id: BreakpointId) => boolean;
  /** Get all breakpoints. */
  readonly breakpoints: () => readonly Breakpoint[];
  /** Release the gate (resume or step). */
  readonly releaseGate: () => void;
  /** Whether the engine is currently paused at a gate. */
  readonly isPaused: () => boolean;
  /** Current turn index. */
  readonly turnIndex: () => number;
  /** Subscribe to debug events. */
  readonly onDebugEvent: (listener: (event: DebugEvent) => void) => () => void;
  /** Get the event buffer. */
  readonly eventBuffer: () => EventRingBuffer;
  /** Get the current paused event (if paused). */
  readonly pausedEvent: () => EngineEvent | undefined;
  /** Get the breakpoint that caused the pause (if any). */
  readonly pausedBreakpointId: () => BreakpointId | undefined;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface DebugMiddlewareResult {
  readonly middleware: KoiMiddleware;
  readonly controller: DebugController;
}

/** Create a debug middleware with controller interface. */
export function createDebugMiddleware(eventBuffer: EventRingBuffer): DebugMiddlewareResult {
  // let justified: mutable active flag
  let active = false;

  // let justified: mutable gate for pausing
  let gate: GateControl | undefined;
  let paused = false;
  let pausedEvt: EngineEvent | undefined;
  let pausedBpId: BreakpointId | undefined;

  // let justified: mutable turn index tracker
  let currentTurnIndex = 0;

  // let justified: mutable breakpoint counter for unique IDs
  let bpCounter = 0;

  // let justified: mutable breakpoint store
  const breakpointMap = new Map<string, BreakpointEntry>();

  // let justified: mutable listener set
  const debugListeners = new Set<(event: DebugEvent) => void>();

  function emitDebugEvent(event: DebugEvent): void {
    for (const listener of debugListeners) {
      listener(event);
    }
  }

  /** Record an engine event and evaluate breakpoints. */
  async function processEvent(event: EngineEvent): Promise<void> {
    eventBuffer.push(event);

    // Track turn index
    if (event.kind === "turn_start") {
      currentTurnIndex = event.turnIndex;
    }

    // Evaluate breakpoints
    for (const [id, bp] of breakpointMap) {
      try {
        if (matchesBreakpoint(bp.predicate, { event, turnIndex: currentTurnIndex })) {
          // Breakpoint hit — gate the engine
          const bpId = bp.id;

          // Remove once-breakpoints before pausing
          if (bp.once) {
            breakpointMap.delete(id);
          }

          emitDebugEvent({
            kind: "breakpoint_hit",
            debugSessionId: "" as ReturnType<typeof import("@koi/core").debugSessionId>,
            breakpointId: bpId,
            turnIndex: currentTurnIndex,
            event,
          });

          // Pause execution
          gate = createGate();
          paused = true;
          pausedEvt = event;
          pausedBpId = bpId;

          emitDebugEvent({
            kind: "paused",
            debugSessionId: "" as ReturnType<typeof import("@koi/core").debugSessionId>,
            breakpointId: bpId,
            turnIndex: currentTurnIndex,
          });

          // Block until released
          await gate.promise;
          paused = false;
          pausedEvt = undefined;
          pausedBpId = undefined;
          gate = undefined;

          emitDebugEvent({
            kind: "resumed",
            debugSessionId: "" as ReturnType<typeof import("@koi/core").debugSessionId>,
          });

          // Only hit one breakpoint per event
          break;
        }
      } catch {
        // Predicate error — auto-remove breakpoint, agent continues
        breakpointMap.delete(id);
      }
    }
  }

  const middleware: KoiMiddleware = {
    name: DEBUG_MIDDLEWARE_NAME,
    priority: DEBUG_MIDDLEWARE_PRIORITY,

    describeCapabilities: () => {
      if (!active) return undefined;
      return {
        label: "debug",
        description: `Debug session active. ${String(breakpointMap.size)} breakpoint(s).`,
      };
    },

    onBeforeTurn: async (_ctx: TurnContext): Promise<void> => {
      if (!active) return;
      await processEvent({ kind: "turn_start", turnIndex: currentTurnIndex });
    },

    onAfterTurn: async (_ctx: TurnContext): Promise<void> => {
      if (!active) return;
      await processEvent({ kind: "turn_end", turnIndex: currentTurnIndex });
    },

    wrapToolCall: async (
      _ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> => {
      if (!active) return next(request);

      await processEvent({
        kind: "tool_call_start",
        toolName: request.toolId,
        callId: "" as ReturnType<typeof import("@koi/core").toolCallId>,
      });

      const response = await next(request);

      await processEvent({
        kind: "tool_call_end",
        callId: "" as ReturnType<typeof import("@koi/core").toolCallId>,
        result: response.output,
      });

      return response;
    },

    wrapModelCall: async (
      _ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> => {
      if (!active) return next(request);
      return next(request);
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

    addBreakpoint: (predicate, options) => {
      bpCounter += 1;
      const id = breakpointId(`bp-${String(bpCounter)}`);
      const entry: BreakpointEntry = {
        id,
        predicate,
        once: options?.once ?? false,
        label: options?.label,
      };
      breakpointMap.set(id as string, entry);
      return { id, predicate, once: entry.once, label: entry.label };
    },

    removeBreakpoint: (id) => breakpointMap.delete(id as string),

    breakpoints: () => {
      return [...breakpointMap.values()].map((bp) => ({
        id: bp.id,
        predicate: bp.predicate,
        once: bp.once,
        label: bp.label,
      }));
    },

    releaseGate: () => {
      if (gate !== undefined) {
        gate.release();
      }
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
  };

  return { middleware, controller };
}

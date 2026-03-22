/**
 * Event-trace middleware factory — traces every LLM/tool call individually,
 * enabling per-event granularity for mid-turn rewind.
 */

import type {
  CapabilityFragment,
  KoiError,
  KoiMiddleware,
  ModelChunk,
  ModelHandler,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
  Result,
  SessionContext,
  SessionId,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
  TurnTrace,
} from "@koi/core";
import { toolCallId } from "@koi/core";
import { getEventsBetween as queryEventsBetween } from "./query.js";
import type { TraceCollector } from "./trace-collector.js";
import { createTraceCollector } from "./trace-collector.js";
import type { EventTraceConfig, EventTraceHandle } from "./types.js";

/** Per-session mutable state for the event-trace middleware. */
interface EventTraceSessionState {
  readonly collector: TraceCollector;
  readonly turnStartTime: number;
}

/**
 * Creates an event-trace middleware that traces every model/tool call
 * at per-event granularity.
 */
export function createEventTraceMiddleware(config: EventTraceConfig): EventTraceHandle {
  const { store, chainId } = config;
  const clock = config.clock ?? Date.now;
  const sessions = new Map<string, EventTraceSessionState>();

  const middleware: KoiMiddleware = {
    name: "event-trace",
    priority: 475,
    describeCapabilities: (ctx: TurnContext): CapabilityFragment => {
      const state = sessions.get(ctx.session.sessionId as string);
      const eventCount = state?.collector.currentIndex() ?? 0;
      return {
        label: "tracing",
        description: `Per-event tracing persisted to chain store (${String(eventCount)} events this turn)`,
      };
    },

    async onSessionStart(ctx: SessionContext): Promise<void> {
      sessions.set(ctx.sessionId as string, {
        collector: createTraceCollector(config.clock),
        turnStartTime: 0,
      });
    },

    async onSessionEnd(ctx: SessionContext): Promise<void> {
      sessions.delete(ctx.sessionId as string);
    },

    async onBeforeTurn(ctx: TurnContext): Promise<void> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return;
      state.collector.reset();
      sessions.set(ctx.session.sessionId as string, {
        ...state,
        turnStartTime: clock(),
      });
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return next(request);

      const startTime = clock();
      let response: ModelResponse | undefined;
      try {
        response = await next(request);
        return response;
      } finally {
        const durationMs = clock() - startTime;
        state.collector.record(ctx.turnIndex, {
          kind: "model_call",
          request,
          response,
          durationMs,
        });
      }
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) {
        yield* next(request);
        return;
      }

      const startTime = clock();

      state.collector.record(ctx.turnIndex, {
        kind: "model_stream_start",
        request,
      });

      let lastResponse: unknown;
      try {
        for await (const chunk of next(request)) {
          if (chunk.kind === "done") {
            lastResponse = chunk.response;
          }
          yield chunk;
        }
      } finally {
        const durationMs = clock() - startTime;
        state.collector.record(ctx.turnIndex, {
          kind: "model_stream_end",
          response: lastResponse,
          durationMs,
        });
      }
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return next(request);

      const startTime = clock();
      const eventIndex = state.collector.currentIndex();
      let response: ToolResponse | undefined;
      try {
        response = await next(request);
        return response;
      } finally {
        const durationMs = clock() - startTime;
        state.collector.record(ctx.turnIndex, {
          kind: "tool_call",
          toolId: request.toolId,
          callId: toolCallId(`trace-${eventIndex}`),
          input: request.input,
          output: response?.output,
          durationMs,
        });
      }
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const state = sessions.get(ctx.session.sessionId as string);
      if (!state) return;

      const durationMs = clock() - state.turnStartTime;

      const turnTrace: TurnTrace = {
        turnIndex: ctx.turnIndex,
        sessionId: ctx.session.sessionId,
        agentId: ctx.session.agentId,
        events: state.collector.getEvents(),
        durationMs,
      };

      try {
        // Find parent IDs from current head
        const headResult = await store.head(chainId);
        const parentIds =
          headResult.ok && headResult.value !== undefined ? [headResult.value.nodeId] : [];

        await store.put(chainId, turnTrace, parentIds);
      } catch (e: unknown) {
        // Degraded mode: trace data lost for this turn, but agent continues.
        // Observability must never crash the observed system.
        console.warn(
          `[event-trace] Failed to persist turn trace (turn ${String(ctx.turnIndex)}):`,
          e instanceof Error ? e.message : e,
        );
      }
    },
  };

  const getTurnTrace = async (
    sid: SessionId,
    turnIndex: number,
  ): Promise<Result<TurnTrace | undefined, KoiError>> => {
    const listResult = await store.list(chainId);
    if (!listResult.ok) {
      return listResult;
    }

    const node = listResult.value.find(
      (n) => n.data.sessionId === sid && n.data.turnIndex === turnIndex,
    );
    if (node === undefined) {
      return { ok: true, value: undefined };
    }
    return { ok: true, value: node.data };
  };

  const getEventsBetween: EventTraceHandle["getEventsBetween"] = async (from, to, sessionId) =>
    queryEventsBetween(store, chainId, from, to, sessionId);

  const currentEventIndex = (sid: SessionId): number => {
    const state = sessions.get(sid as string);
    return state?.collector.currentIndex() ?? 0;
  };

  return {
    middleware,
    getTurnTrace,
    getEventsBetween,
    currentEventIndex,
  };
}

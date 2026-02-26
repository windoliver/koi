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
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
  TurnTrace,
} from "@koi/core";
import { toolCallId } from "@koi/core";
import { getEventsBetween as queryEventsBetween } from "./query.js";
import { createTraceCollector } from "./trace-collector.js";
import type { EventTraceConfig, EventTraceHandle } from "./types.js";

/**
 * Creates an event-trace middleware that traces every model/tool call
 * at per-event granularity.
 */
export function createEventTraceMiddleware(config: EventTraceConfig): EventTraceHandle {
  const { store, chainId } = config;
  const clock = config.clock ?? Date.now;
  const collector = createTraceCollector(config.clock);

  // Mutable turn-scoped state — reset each turn
  let turnStartTime = 0;

  const capabilityFragment: CapabilityFragment = {
    label: "tracing",
    description: "Event tracing active",
  };

  const middleware: KoiMiddleware = {
    name: "event-trace",
    priority: 475,
    describeCapabilities: (_ctx: TurnContext): CapabilityFragment => capabilityFragment,

    async onBeforeTurn(_ctx: TurnContext): Promise<void> {
      collector.reset();
      turnStartTime = clock();
    },

    async wrapModelCall(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelHandler,
    ): Promise<ModelResponse> {
      const startTime = clock();
      const response = await next(request);
      const durationMs = clock() - startTime;

      collector.record(ctx.turnIndex, {
        kind: "model_call",
        request,
        response,
        durationMs,
      });

      return response;
    },

    async *wrapModelStream(
      ctx: TurnContext,
      request: ModelRequest,
      next: ModelStreamHandler,
    ): AsyncIterable<ModelChunk> {
      const startTime = clock();

      collector.record(ctx.turnIndex, {
        kind: "model_stream_start",
        request,
      });

      let lastResponse: unknown;
      for await (const chunk of next(request)) {
        if (chunk.kind === "done") {
          lastResponse = chunk.response;
        }
        yield chunk;
      }

      const durationMs = clock() - startTime;
      collector.record(ctx.turnIndex, {
        kind: "model_stream_end",
        response: lastResponse,
        durationMs,
      });
    },

    async wrapToolCall(
      ctx: TurnContext,
      request: ToolRequest,
      next: ToolHandler,
    ): Promise<ToolResponse> {
      const startTime = clock();
      const response = await next(request);
      const durationMs = clock() - startTime;

      const eventIndex = collector.currentIndex();
      collector.record(ctx.turnIndex, {
        kind: "tool_call",
        toolId: request.toolId,
        callId: toolCallId(`trace-${eventIndex}`),
        input: request.input,
        output: response.output,
        durationMs,
      });

      return response;
    },

    async onAfterTurn(ctx: TurnContext): Promise<void> {
      const durationMs = clock() - turnStartTime;

      const turnTrace: TurnTrace = {
        turnIndex: ctx.turnIndex,
        sessionId: ctx.session.sessionId,
        agentId: ctx.session.agentId,
        events: collector.getEvents(),
        durationMs,
      };

      // Find parent IDs from current head
      const headResult = await store.head(chainId);
      const parentIds =
        headResult.ok && headResult.value !== undefined ? [headResult.value.nodeId] : [];

      await store.put(chainId, turnTrace, parentIds);
    },
  };

  const getTurnTrace = async (
    turnIndex: number,
  ): Promise<Result<TurnTrace | undefined, KoiError>> => {
    const listResult = await store.list(chainId);
    if (!listResult.ok) {
      return listResult;
    }

    const node = listResult.value.find((n) => n.data.turnIndex === turnIndex);
    if (node === undefined) {
      return { ok: true, value: undefined };
    }
    return { ok: true, value: node.data };
  };

  const getEventsBetween: EventTraceHandle["getEventsBetween"] = async (from, to) =>
    queryEventsBetween(store, chainId, from, to);

  const currentEventIndex = (): number => collector.currentIndex();

  return {
    middleware,
    getTurnTrace,
    getEventsBetween,
    currentEventIndex,
  };
}

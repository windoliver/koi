import { beforeEach, describe, expect, test } from "bun:test";
import type {
  ChainId,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SnapshotChainStore,
  TurnTrace,
} from "@koi/core";
import { chainId, runId, sessionId } from "@koi/core";
import { createInMemorySnapshotChainStore } from "@koi/snapshot-chain-store";
import {
  createMockModelHandler,
  createMockToolHandler,
  createMockTurnContext,
} from "@koi/test-utils";
import { createEventTraceMiddleware } from "./event-trace.js";
import type { EventTraceHandle } from "./types.js";

/**
 * Helper that asserts an optional middleware hook is defined,
 * avoiding non-null assertions (`!`) banned by Biome.
 */
function assertDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${name} to be defined`);
  }
  return value;
}

/** Typed accessors for the optional middleware hooks under test. */
function hooks(mw: KoiMiddleware) {
  return {
    onBeforeTurn: assertDefined(mw.onBeforeTurn, "onBeforeTurn"),
    onAfterTurn: assertDefined(mw.onAfterTurn, "onAfterTurn"),
    wrapModelCall: assertDefined(mw.wrapModelCall, "wrapModelCall"),
    wrapModelStream: assertDefined(mw.wrapModelStream, "wrapModelStream"),
    wrapToolCall: assertDefined(mw.wrapToolCall, "wrapToolCall"),
  };
}

describe("createEventTraceMiddleware", () => {
  let store: SnapshotChainStore<TurnTrace>;
  let handle: EventTraceHandle;
  let tick: number;
  const cid: ChainId = chainId("trace-chain");

  beforeEach(() => {
    tick = 1000;
    store = createInMemorySnapshotChainStore<TurnTrace>();
    handle = createEventTraceMiddleware({
      store,
      chainId: cid,
      clock: () => tick,
    });
  });

  test("wrapModelCall returns response unchanged", async () => {
    const ctx = createMockTurnContext({ turnIndex: 0 });
    const next = createMockModelHandler({ content: "hello" });
    const request: ModelRequest = { messages: [] };
    const h = hooks(handle.middleware);

    await h.onBeforeTurn(ctx);
    const response = await h.wrapModelCall(ctx, request, next);

    expect(response.content).toBe("hello");
  });

  test("wrapModelCall records model_call event with timing", async () => {
    const ctx = createMockTurnContext({ turnIndex: 0 });
    const next = createMockModelHandler();
    const request: ModelRequest = { messages: [] };
    const h = hooks(handle.middleware);

    await h.onBeforeTurn(ctx);

    tick = 1000;
    const timedNext = async (req: ModelRequest): Promise<ModelResponse> => {
      tick = 1050;
      return next(req);
    };

    await h.wrapModelCall(ctx, request, timedNext);
    await h.onAfterTurn(ctx);

    const traceResult = await handle.getTurnTrace(0);
    expect(traceResult.ok).toBe(true);
    if (traceResult.ok && traceResult.value !== undefined) {
      expect(traceResult.value.events).toHaveLength(1);
      expect(traceResult.value.events[0]?.event.kind).toBe("model_call");
      if (traceResult.value.events[0]?.event.kind === "model_call") {
        expect(traceResult.value.events[0].event.durationMs).toBe(50);
      }
    }
  });

  test("wrapToolCall records tool_call event with timing", async () => {
    const ctx = createMockTurnContext({ turnIndex: 0 });
    const next = createMockToolHandler({ output: { result: "ok" } });
    const h = hooks(handle.middleware);

    await h.onBeforeTurn(ctx);

    tick = 2000;
    const timedNext = async (req: {
      readonly toolId: string;
      readonly input: Record<string, unknown>;
      readonly metadata?: Record<string, unknown>;
    }) => {
      tick = 2030;
      return next(req);
    };

    await h.wrapToolCall(ctx, { toolId: "my-tool", input: { key: "val" } }, timedNext);
    await h.onAfterTurn(ctx);

    const traceResult = await handle.getTurnTrace(0);
    expect(traceResult.ok).toBe(true);
    if (traceResult.ok && traceResult.value !== undefined) {
      expect(traceResult.value.events).toHaveLength(1);
      const event = traceResult.value.events[0]?.event;
      expect(event?.kind).toBe("tool_call");
      if (event?.kind === "tool_call") {
        expect(event.toolId).toBe("my-tool");
        expect(event.durationMs).toBe(30);
        expect(event.callId).toMatch(/^trace-/);
      }
    }
  });

  test("onBeforeTurn resets events for new turn", async () => {
    const ctx0 = createMockTurnContext({ turnIndex: 0 });
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    const next = createMockModelHandler();
    const h = hooks(handle.middleware);

    // Turn 0
    await h.onBeforeTurn(ctx0);
    await h.wrapModelCall(ctx0, { messages: [] }, next);
    await h.onAfterTurn(ctx0);

    // Turn 1 — should start fresh
    await h.onBeforeTurn(ctx1);
    await h.wrapModelCall(ctx1, { messages: [] }, next);
    await h.onAfterTurn(ctx1);

    const trace0 = await handle.getTurnTrace(0);
    const trace1 = await handle.getTurnTrace(1);

    expect(trace0.ok).toBe(true);
    expect(trace1.ok).toBe(true);
    if (trace0.ok && trace0.value !== undefined) {
      expect(trace0.value.events).toHaveLength(1);
    }
    if (trace1.ok && trace1.value !== undefined) {
      expect(trace1.value.events).toHaveLength(1);
      // Event indices are monotonic across turns
      expect(trace1.value.events[0]?.eventIndex).toBe(1);
    }
  });

  test("onAfterTurn stores TurnTrace in chain", async () => {
    const ctx = createMockTurnContext({
      turnIndex: 0,
      session: {
        sessionId: sessionId("sess-1"),
        runId: runId("run-1"),
        agentId: "agent-1",
        metadata: {},
      },
    });
    const next = createMockModelHandler();
    const h = hooks(handle.middleware);

    await h.onBeforeTurn(ctx);
    await h.wrapModelCall(ctx, { messages: [] }, next);
    await h.onAfterTurn(ctx);

    const headResult = await store.head(cid);
    expect(headResult.ok).toBe(true);
    if (headResult.ok && headResult.value !== undefined) {
      expect(headResult.value.data.sessionId).toBe(sessionId("sess-1"));
      expect(headResult.value.data.agentId).toBe("agent-1");
      expect(headResult.value.data.turnIndex).toBe(0);
    }
  });

  test("currentEventIndex exposed correctly", async () => {
    expect(handle.currentEventIndex()).toBe(0);

    const ctx = createMockTurnContext({ turnIndex: 0 });
    const next = createMockModelHandler();
    const h = hooks(handle.middleware);

    await h.onBeforeTurn(ctx);
    await h.wrapModelCall(ctx, { messages: [] }, next);

    expect(handle.currentEventIndex()).toBe(1);
  });

  test("getTurnTrace returns undefined for non-existent turn", async () => {
    const result = await handle.getTurnTrace(99);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeUndefined();
    }
  });

  test("getEventsBetween delegates correctly", async () => {
    const ctx0 = createMockTurnContext({ turnIndex: 0 });
    const ctx1 = createMockTurnContext({ turnIndex: 1 });
    const modelNext = createMockModelHandler();
    const toolNext = createMockToolHandler();
    const h = hooks(handle.middleware);

    // Turn 0: model call + tool call
    await h.onBeforeTurn(ctx0);
    await h.wrapModelCall(ctx0, { messages: [] }, modelNext);
    await h.wrapToolCall(ctx0, { toolId: "t1", input: {} }, toolNext);
    await h.onAfterTurn(ctx0);

    // Turn 1: model call
    await h.onBeforeTurn(ctx1);
    await h.wrapModelCall(ctx1, { messages: [] }, modelNext);
    await h.onAfterTurn(ctx1);

    const result = await handle.getEventsBetween(
      { turnIndex: 0, eventIndex: 1 },
      { turnIndex: 1, eventIndex: 2 },
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Turn 0 event at index 1 + Turn 1 event at index 2
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.eventIndex).toBe(1);
      expect(result.value[1]?.eventIndex).toBe(2);
    }
  });

  test("wrapModelStream records stream_start and stream_end events", async () => {
    const ctx = createMockTurnContext({ turnIndex: 0 });
    const h = hooks(handle.middleware);

    const mockChunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "hello" },
      { kind: "text_delta", delta: " world" },
      { kind: "done", response: { content: "hello world", model: "test" } },
    ];

    const streamNext = async function* (_request: ModelRequest): AsyncIterable<ModelChunk> {
      for (const chunk of mockChunks) {
        if (chunk.kind === "text_delta") {
          tick += 10;
        }
        yield chunk;
      }
    };

    tick = 1000;
    await h.onBeforeTurn(ctx);

    const chunks: ModelChunk[] = [];
    for await (const chunk of h.wrapModelStream(ctx, { messages: [] }, streamNext)) {
      chunks.push(chunk);
    }

    await h.onAfterTurn(ctx);

    // All chunks should be yielded through
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.kind).toBe("text_delta");
    expect(chunks[2]?.kind).toBe("done");

    const traceResult = await handle.getTurnTrace(0);
    expect(traceResult.ok).toBe(true);
    if (traceResult.ok && traceResult.value !== undefined) {
      expect(traceResult.value.events).toHaveLength(2);
      expect(traceResult.value.events[0]?.event.kind).toBe("model_stream_start");
      expect(traceResult.value.events[1]?.event.kind).toBe("model_stream_end");
      if (traceResult.value.events[1]?.event.kind === "model_stream_end") {
        expect(traceResult.value.events[1].event.durationMs).toBeGreaterThan(0);
      }
    }
  });
});

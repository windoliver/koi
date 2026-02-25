import { describe, expect, test } from "bun:test";
import type { BaseEvent } from "@ag-ui/core";
import { EventType } from "@ag-ui/core";
import type {
  ModelChunk,
  ModelRequest,
  ToolHandler,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createAguiStreamMiddleware } from "./agui-middleware.js";
import type { SseWriter } from "./run-context-store.js";
import { createRunContextStore } from "./run-context-store.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeContext(runId: string): TurnContext {
  return {
    session: {
      agentId: "agent-1",
      sessionId: "session-1" as import("@koi/core").SessionId,
      runId: runId as import("@koi/core").RunId,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "turn-1" as import("@koi/core").TurnId,
    messages: [],
    metadata: {},
  };
}

async function* makeChunkStream(chunks: readonly ModelChunk[]): AsyncIterable<ModelChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Create a lightweight mock SseWriter that captures written bytes.
 * Avoids real WritableStream backpressure issues in tests.
 */
function makeMockWriter(): { writer: SseWriter; capturedEvents: () => readonly BaseEvent[] } {
  const events: BaseEvent[] = [];
  const decoder = new TextDecoder();

  // Build a mock that looks like WritableStreamDefaultWriter<Uint8Array>
  const writer = {
    write: async (chunk: Uint8Array): Promise<void> => {
      const text = decoder.decode(chunk);
      for (const frame of text.split("\n\n")) {
        const trimmed = frame.trim();
        if (trimmed.startsWith("data: ")) {
          try {
            events.push(JSON.parse(trimmed.slice(6)) as BaseEvent);
          } catch {
            // ignore malformed frames
          }
        }
      }
    },
    close: async (): Promise<void> => {},
    abort: async (): Promise<void> => {},
    releaseLock: (): void => {},
    get closed(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
    get ready(): Promise<undefined> {
      return Promise.resolve(undefined);
    },
    get desiredSize(): number | null {
      return 1;
    },
  } as unknown as SseWriter;

  return { writer, capturedEvents: () => [...events] };
}

interface StoreWithCapture {
  readonly store: ReturnType<typeof createRunContextStore>;
  readonly capturedEvents: () => readonly BaseEvent[];
  readonly runId: string;
}

function makeStoreWithCapture(runId = "run-test"): StoreWithCapture {
  const { writer, capturedEvents } = makeMockWriter();
  const store = createRunContextStore();
  const ac = new AbortController();
  store.register(runId, writer, ac.signal);
  return { store, capturedEvents, runId };
}

const EMPTY_MODEL_REQUEST: ModelRequest = {
  messages: [],
  model: "test",
};

// ---------------------------------------------------------------------------
// wrapModelStream tests
// ---------------------------------------------------------------------------

describe("createAguiStreamMiddleware — wrapModelStream", () => {
  test("text_delta chunks produce TEXT_MESSAGE_START + CONTENT + END", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "Hello" },
      { kind: "text_delta", delta: " world" },
      { kind: "done", response: { content: "Hello world", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );

    const yielded: ModelChunk[] = [];
    for await (const c of gen) {
      yielded.push(c);
    }

    expect(yielded).toHaveLength(3);

    const events = capturedEvents();
    expect(events[0]).toMatchObject({ type: EventType.STEP_STARTED, stepName: "agent" });
    expect(events[1]).toMatchObject({ type: EventType.TEXT_MESSAGE_START });
    expect(events[2]).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT, delta: "Hello" });
    expect(events[3]).toMatchObject({ type: EventType.TEXT_MESSAGE_CONTENT, delta: " world" });
    expect(events[4]).toMatchObject({ type: EventType.TEXT_MESSAGE_END });
    expect(events[5]).toMatchObject({ type: EventType.STEP_FINISHED, stepName: "agent" });
  });

  test("tool_call_start/delta/end produce TOOL_CALL_START/ARGS/END", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const callId = "call-1" as import("@koi/core").ToolCallId;
    const chunks: ModelChunk[] = [
      { kind: "tool_call_start", toolName: "search", callId },
      { kind: "tool_call_delta", callId, delta: '{"q":' },
      { kind: "tool_call_delta", callId, delta: '"foo"}' },
      { kind: "tool_call_end", callId },
      { kind: "done", response: { content: "", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );
    for await (const _ of gen) {
      // consume
    }

    const events = capturedEvents();
    expect(events[0]).toMatchObject({ type: EventType.STEP_STARTED, stepName: "agent" });
    expect(events[1]).toMatchObject({ type: EventType.TOOL_CALL_START, toolCallName: "search" });
    expect(events[2]).toMatchObject({ type: EventType.TOOL_CALL_ARGS, delta: '{"q":' });
    expect(events[3]).toMatchObject({ type: EventType.TOOL_CALL_ARGS, delta: '"foo"}' });
    expect(events[4]).toMatchObject({ type: EventType.TOOL_CALL_END });
    expect(events[5]).toMatchObject({ type: EventType.STEP_FINISHED, stepName: "agent" });
  });

  test("text followed by tool call: TEXT_MESSAGE_END precedes TOOL_CALL_START", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const callId = "call-2" as import("@koi/core").ToolCallId;
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "I will call a tool" },
      { kind: "tool_call_start", toolName: "calc", callId },
      { kind: "tool_call_end", callId },
      { kind: "done", response: { content: "", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );
    for await (const _ of gen) {
      // consume
    }

    const events = capturedEvents();
    const types = events.map((e) => e.type);
    expect(types.indexOf(EventType.TEXT_MESSAGE_END)).toBeLessThan(
      types.indexOf(EventType.TOOL_CALL_START),
    );
  });

  test("concurrent tool calls have distinct toolCallIds", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const callId1 = "call-a" as import("@koi/core").ToolCallId;
    const callId2 = "call-b" as import("@koi/core").ToolCallId;
    const chunks: ModelChunk[] = [
      { kind: "tool_call_start", toolName: "a", callId: callId1 },
      { kind: "tool_call_start", toolName: "b", callId: callId2 },
      { kind: "tool_call_end", callId: callId1 },
      { kind: "tool_call_end", callId: callId2 },
      { kind: "done", response: { content: "", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );
    for await (const _ of gen) {
      // consume
    }

    const events = capturedEvents();
    const startEvents = events.filter((e) => e.type === EventType.TOOL_CALL_START);
    const ids = startEvents.map((e) => (e as { toolCallId?: string }).toolCallId);
    expect(ids).toContain("call-a");
    expect(ids).toContain("call-b");
  });

  test("markTextStreamed is set when text chunks are processed", async () => {
    const { store, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "Hi" },
      { kind: "done", response: { content: "Hi", model: "test" } },
    ];

    expect(store.hasTextStreamed(runId)).toBe(false);

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );
    for await (const _ of gen) {
      // consume
    }

    expect(store.hasTextStreamed(runId)).toBe(true);
  });

  test("thinking_delta chunks produce REASONING_MESSAGE_START + CONTENT", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const chunks: ModelChunk[] = [
      { kind: "thinking_delta", delta: "Let me think" },
      { kind: "thinking_delta", delta: " about this" },
      { kind: "done", response: { content: "", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );
    for await (const _ of gen) {
      // consume
    }

    const events = capturedEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.REASONING_MESSAGE_START);
    expect(types).toContain(EventType.REASONING_MESSAGE_CONTENT);
    expect(types).toContain(EventType.REASONING_MESSAGE_END);
    const contentEvents = events.filter((e) => e.type === EventType.REASONING_MESSAGE_CONTENT);
    expect(contentEvents[0]).toMatchObject({ delta: "Let me think" });
    expect(contentEvents[1]).toMatchObject({ delta: " about this" });
  });

  test("stream ending without 'done' chunk closes open TEXT_MESSAGE", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    // No "done" chunk — stream ends abruptly
    const chunks: ModelChunk[] = [{ kind: "text_delta", delta: "incomplete" }];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );
    for await (const _ of gen) {
      // consume
    }

    const events = capturedEvents();
    const types = events.map((e) => e.type);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.TEXT_MESSAGE_CONTENT);
    // Guard should emit TEXT_MESSAGE_END even without "done"
    expect(types).toContain(EventType.TEXT_MESSAGE_END);
  });

  test("no writer registered — passthrough without SSE events", async () => {
    const store = createRunContextStore(); // empty store
    const middleware = createAguiStreamMiddleware({ store });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "test" },
      { kind: "done", response: { content: "test", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(
      makeContext("unregistered-run"),
      EMPTY_MODEL_REQUEST,
      () => makeChunkStream(chunks),
    );

    const yielded: ModelChunk[] = [];
    for await (const c of gen) {
      yielded.push(c);
    }

    // Chunks still yielded — engine still processes its stream
    expect(yielded).toHaveLength(2);
  });

  test("early exit when client disconnects mid-stream: all chunks still yielded", async () => {
    const { store, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "partial" },
      { kind: "text_delta", delta: " response" },
      { kind: "done", response: { content: "partial response", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );

    const yielded: ModelChunk[] = [];
    for await (const c of gen) {
      yielded.push(c);
      // Simulate client disconnect after first chunk
      if (yielded.length === 1) {
        store.deregister(runId);
      }
    }

    // All chunks still yielded — engine finishes processing even after disconnect
    expect(yielded).toHaveLength(3);
  });

  test("STEP_STARTED is the first SSE event emitted", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "hi" },
      { kind: "done", response: { content: "hi", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );
    for await (const _ of gen) {
      /* consume */
    }

    const events = capturedEvents();
    expect(events[0]).toMatchObject({ type: EventType.STEP_STARTED, stepName: "agent" });
  });

  test("STEP_FINISHED is the last SSE event emitted", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "hi" },
      { kind: "done", response: { content: "hi", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream(chunks),
    );
    for await (const _ of gen) {
      /* consume */
    }

    const events = capturedEvents();
    expect(events.at(-1)).toMatchObject({ type: EventType.STEP_FINISHED, stepName: "agent" });
  });

  test("STEP_FINISHED emitted even when stream ends without 'done' chunk", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(makeContext(runId), EMPTY_MODEL_REQUEST, () =>
      makeChunkStream([{ kind: "text_delta", delta: "abrupt end" }]),
    );
    for await (const _ of gen) {
      /* consume */
    }

    const types = capturedEvents().map((e) => e.type);
    expect(types[0]).toBe(EventType.STEP_STARTED);
    expect(types.at(-1)).toBe(EventType.STEP_FINISHED);
  });

  test("resolves writer via AG-UI runId in message metadata when session.runId differs", async () => {
    // Simulate real createKoi assembly: store registered under the client's AG-UI runId,
    // but ctx.session.runId is the Koi-internal runId (a different value).
    const aguiRunId = "agui-run-abc";
    const { writer, capturedEvents } = makeMockWriter();
    const store = createRunContextStore();
    const ac = new AbortController();
    store.register(aguiRunId, writer, ac.signal);

    const ctx: TurnContext = {
      ...makeContext("koi-internal-xyz"), // session.runId does NOT match store
      messages: [
        {
          content: [{ kind: "text", text: "hello" }],
          senderId: "user",
          timestamp: Date.now(),
          metadata: { runId: aguiRunId }, // AG-UI runId DOES match store
        },
      ],
    };

    const middleware = createAguiStreamMiddleware({ store });
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "hi" },
      { kind: "done", response: { content: "hi", model: "test" } },
    ];

    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(ctx, EMPTY_MODEL_REQUEST, () => makeChunkStream(chunks));
    for await (const _ of gen) {
      /* consume */
    }

    const types = capturedEvents().map((e) => e.type);
    expect(types).toContain(EventType.STEP_STARTED);
    expect(types).toContain(EventType.TEXT_MESSAGE_START);
    expect(types).toContain(EventType.STEP_FINISHED);
  });

  test("no STEP events when no writer is registered", async () => {
    const store = createRunContextStore(); // empty store — no writer
    const middleware = createAguiStreamMiddleware({ store });

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "ghost" },
      { kind: "done", response: { content: "ghost", model: "test" } },
    ];

    // Should pass through without throwing — no writer to write to
    if (middleware.wrapModelStream === undefined) throw new Error("expected wrapModelStream");
    const gen = middleware.wrapModelStream(
      makeContext("unregistered-run-2"),
      EMPTY_MODEL_REQUEST,
      () => makeChunkStream(chunks),
    );
    const yielded: ModelChunk[] = [];
    for await (const c of gen) {
      yielded.push(c);
    }

    expect(yielded).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// wrapToolCall tests
// ---------------------------------------------------------------------------

describe("createAguiStreamMiddleware — wrapToolCall", () => {
  test("emits TOOL_CALL_RESULT with serialized output", async () => {
    const { store, capturedEvents, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const toolRequest: ToolRequest = {
      toolId: "search-tool",
      input: { q: "bun runtime" },
    };
    const mockNext: ToolHandler = async () => ({
      output: { results: ["Bun is fast"] },
    });

    await middleware.wrapToolCall?.(makeContext(runId), toolRequest, mockNext);

    const events = capturedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: EventType.TOOL_CALL_RESULT,
      toolCallId: "search-tool",
      result: JSON.stringify({ results: ["Bun is fast"] }),
    });
  });

  test("returns tool response from next()", async () => {
    const { store, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    const expected: ToolResponse = { output: { answer: 42 } };
    const result = await middleware.wrapToolCall?.(
      makeContext(runId),
      { toolId: "calc", input: {} },
      async () => expected,
    );

    expect(result).toEqual(expected);
  });

  test("no-op when no writer registered", async () => {
    const store = createRunContextStore(); // empty
    const middleware = createAguiStreamMiddleware({ store });

    // Should not throw
    const result = await middleware.wrapToolCall?.(
      makeContext("unknown-run"),
      { toolId: "tool", input: {} },
      async () => ({ output: "ok" }),
    );
    expect(result).toEqual({ output: "ok" });
  });

  test("tool call with error output still returns response to engine", async () => {
    const { store, runId } = makeStoreWithCapture();
    const middleware = createAguiStreamMiddleware({ store });

    if (middleware.wrapToolCall === undefined) throw new Error("expected wrapToolCall");
    const result = await middleware.wrapToolCall(
      makeContext(runId),
      { toolId: "fail-tool", input: {} },
      async () => ({ output: { error: "not found" } }),
    );
    expect(result.output).toEqual({ error: "not found" });
  });
});

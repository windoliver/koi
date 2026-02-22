import { describe, expect, test } from "bun:test";
import type { ModelRequest, ModelStreamHandler } from "@koi/core/middleware";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { piParamsStore } from "./model-terminal.js";
import { createBridgeStreamFn, modelChunkToAssistantEvent } from "./stream-bridge.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePartialMessage(overrides?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeModel() {
  return {
    id: "claude-sonnet-4-5-20250929",
    name: "Claude Sonnet 4.5",
    api: "anthropic-messages" as const,
    provider: "anthropic" as const,
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text" as const, "image" as const],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
}

function makeContext() {
  return {
    systemPrompt: "You are helpful.",
    messages: [{ role: "user" as const, content: "hello", timestamp: Date.now() }],
    tools: [],
  };
}

async function collectStreamEvents(
  streamOrPromise: AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
): Promise<readonly AssistantMessageEvent[]> {
  const stream = await streamOrPromise;
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// modelChunkToAssistantEvent
// ---------------------------------------------------------------------------

describe("modelChunkToAssistantEvent", () => {
  const partial = makePartialMessage();

  test("maps text_delta chunk", () => {
    const event = modelChunkToAssistantEvent({ kind: "text_delta", delta: "hi" }, partial);
    expect(event?.type).toBe("text_delta");
    if (event?.type === "text_delta") {
      expect(event.delta).toBe("hi");
    }
  });

  test("maps thinking_delta chunk", () => {
    const event = modelChunkToAssistantEvent({ kind: "thinking_delta", delta: "hmm" }, partial);
    expect(event?.type).toBe("thinking_delta");
    if (event?.type === "thinking_delta") {
      expect(event.delta).toBe("hmm");
    }
  });

  test("maps tool_call_start chunk", () => {
    const event = modelChunkToAssistantEvent(
      { kind: "tool_call_start", toolName: "search", callId: "c1" },
      partial,
    );
    expect(event?.type).toBe("toolcall_start");
  });

  test("maps tool_call_delta chunk", () => {
    const event = modelChunkToAssistantEvent(
      { kind: "tool_call_delta", callId: "c1", delta: '{"q":' },
      partial,
    );
    expect(event?.type).toBe("toolcall_delta");
    if (event?.type === "toolcall_delta") {
      expect(event.delta).toBe('{"q":');
    }
  });

  test("returns undefined for tool_call_end", () => {
    const event = modelChunkToAssistantEvent({ kind: "tool_call_end", callId: "c1" }, partial);
    expect(event).toBeUndefined();
  });

  test("returns undefined for usage", () => {
    const event = modelChunkToAssistantEvent(
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
      partial,
    );
    expect(event).toBeUndefined();
  });

  test("maps done to done event", () => {
    const event = modelChunkToAssistantEvent(
      {
        kind: "done",
        response: { content: "ok", model: "m", usage: { inputTokens: 0, outputTokens: 0 } },
      },
      partial,
    );
    expect(event?.type).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// createBridgeStreamFn
// ---------------------------------------------------------------------------

describe("createBridgeStreamFn", () => {
  test("routes through modelStream and produces AssistantMessageEvents", async () => {
    const mockModelStream: ModelStreamHandler = async function* (_request: ModelRequest) {
      yield { kind: "text_delta" as const, delta: "hello " };
      yield { kind: "text_delta" as const, delta: "world" };
      yield { kind: "usage" as const, inputTokens: 10, outputTokens: 5 };
      yield {
        kind: "done" as const,
        response: {
          content: "hello world",
          model: "test-model",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      };
    };

    const realStreamSimple: StreamFn = () => {
      throw new Error("Should not be called in bridge mode");
    };

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    const textEvents = events.filter((e) => e.type === "text_delta");
    expect(textEvents).toHaveLength(2);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
  });

  test("passes model id and messages to ModelRequest", async () => {
    let capturedRequest: ModelRequest | undefined;

    const mockModelStream: ModelStreamHandler = async function* (request: ModelRequest) {
      capturedRequest = request;
      yield {
        kind: "done" as const,
        response: { content: "", model: "test", usage: { inputTokens: 0, outputTokens: 0 } },
      };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const model = makeModel();
    const context = makeContext();

    const stream = bridgeFn(model, context);
    for await (const _event of await stream) {
      /* drain */
    }

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.model).toBe("claude-sonnet-4-5-20250929");
    expect(capturedRequest?.messages).toHaveLength(1);
    expect(capturedRequest?.messages[0]?.senderId).toBe("user");
  });

  test("passes temperature and maxTokens from options", async () => {
    let capturedRequest: ModelRequest | undefined;

    const mockModelStream: ModelStreamHandler = async function* (request: ModelRequest) {
      capturedRequest = request;
      yield {
        kind: "done" as const,
        response: { content: "", model: "test", usage: { inputTokens: 0, outputTokens: 0 } },
      };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext(), { temperature: 0.7, maxTokens: 1000 });
    for await (const _event of await stream) {
      /* drain */
    }

    expect(capturedRequest?.temperature).toBe(0.7);
    expect(capturedRequest?.maxTokens).toBe(1000);
  });

  test("emits error event on middleware failure", async () => {
    // biome-ignore lint/correctness/useYield: intentionally throws before yielding to test error path
    const mockModelStream: ModelStreamHandler = async function* (_request: ModelRequest) {
      throw new Error("middleware exploded");
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0]?.type === "error") {
      expect(errorEvents[0].error.errorMessage).toBe("middleware exploded");
    }
  });

  test("stores pi-native params in piParamsStore for terminal", async () => {
    let capturedRequest: ModelRequest | undefined;

    const mockModelStream: ModelStreamHandler = async function* (request: ModelRequest) {
      capturedRequest = request;
      yield {
        kind: "done" as const,
        response: { content: "", model: "test", usage: { inputTokens: 0, outputTokens: 0 } },
      };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    for await (const _event of await stream) {
      /* drain */
    }

    expect(capturedRequest).toBeDefined();
    if (capturedRequest) {
      const piParams = piParamsStore.get(capturedRequest);
      expect(piParams).toBeDefined();
      expect(typeof piParams?.callBoundStream).toBe("function");
    }
  });

  test("handles modelStream that yields no done chunk (fallback path)", async () => {
    const mockModelStream: ModelStreamHandler = async function* (_request: ModelRequest) {
      yield { kind: "text_delta" as const, delta: "partial" };
      yield { kind: "usage" as const, inputTokens: 5, outputTokens: 3 };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents.length).toBeGreaterThanOrEqual(1);
    if (doneEvents[0]?.type === "done") {
      expect(doneEvents[0].message.content).toEqual([{ type: "text", text: "partial" }]);
    }
  });

  test("callBoundStream in piParams calls realStreamSimple with model/context", async () => {
    let _capturedRequest: ModelRequest | undefined;
    let streamSimpleCalled = false;

    const mockModelStream: ModelStreamHandler = async function* (request: ModelRequest) {
      _capturedRequest = request;
      // Simulate the terminal calling callBoundStream
      const piParams = piParamsStore.get(request);
      if (piParams?.callBoundStream) {
        piParams.callBoundStream({ temperature: 0.9 });
      }
      yield {
        kind: "done" as const,
        response: { content: "", model: "test", usage: { inputTokens: 0, outputTokens: 0 } },
      };
    };

    const realStreamSimple: StreamFn = () => {
      streamSimpleCalled = true;
      const s = createAssistantMessageEventStream();
      queueMicrotask(() => {
        s.push({ type: "done" as const, reason: "stop" as const, message: makePartialMessage() });
        s.end(makePartialMessage());
      });
      return s;
    };

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext(), { temperature: 0.5 });
    for await (const _event of await stream) {
      /* drain */
    }

    expect(streamSimpleCalled).toBe(true);
  });

  test("handles non-Error throw in modelStream", async () => {
    // biome-ignore lint/correctness/useYield: intentionally throws before yielding to test error path
    const mockModelStream: ModelStreamHandler = async function* (_request: ModelRequest) {
      throw "string error";
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    const errorEvents = events.filter((e) => e.type === "error");
    expect(errorEvents).toHaveLength(1);
    if (errorEvents[0]?.type === "error") {
      expect(errorEvents[0].error.errorMessage).toBe("string error");
    }
  });
});

import { describe, expect, test } from "bun:test";
import { toolCallId } from "@koi/core/ecs";
import type { ModelRequest, ModelStreamHandler } from "@koi/core/middleware";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessageEvent, AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { PI_PARAMS_NONCE_KEY, piParamsStore } from "./model-terminal.js";
import { createBridgeStreamFn, modelChunkToAssistantEvent } from "./stream-bridge.js";
import { makePartialMessage } from "./test-helpers.js";

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
      { kind: "tool_call_start", toolName: "search", callId: toolCallId("c1") },
      partial,
    );
    expect(event?.type).toBe("toolcall_start");
  });

  test("maps tool_call_delta chunk", () => {
    const event = modelChunkToAssistantEvent(
      { kind: "tool_call_delta", callId: toolCallId("c1"), delta: '{"q":' },
      partial,
    );
    expect(event?.type).toBe("toolcall_delta");
    if (event?.type === "toolcall_delta") {
      expect(event.delta).toBe('{"q":');
    }
  });

  test("returns undefined for tool_call_end", () => {
    const event = modelChunkToAssistantEvent(
      { kind: "tool_call_end", callId: toolCallId("c1") },
      partial,
    );
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
      // Nonce-based lookup: extract nonce from metadata and look up in Map
      const nonce = capturedRequest.metadata?.[PI_PARAMS_NONCE_KEY] as string | undefined;
      expect(nonce).toBeDefined();
      // Note: getPiParams auto-deletes, so use piParamsStore.get directly for inspection
      // The entry was already consumed by the modelStream terminal, so it may be gone.
      // Instead, verify nonce was set in metadata (the actual lookup is tested via terminal tests).
      expect(typeof nonce).toBe("string");
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
    let streamSimpleCalled = false;

    const mockModelStream: ModelStreamHandler = async function* (request: ModelRequest) {
      // Simulate the terminal calling callBoundStream via nonce lookup
      const nonce = request.metadata?.[PI_PARAMS_NONCE_KEY] as string | undefined;
      const piParams = nonce !== undefined ? piParamsStore.get(nonce) : undefined;
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

  test("reconstructs tool calls in final message from streaming chunks", async () => {
    const mockModelStream: ModelStreamHandler = async function* (_request: ModelRequest) {
      yield { kind: "text_delta" as const, delta: "Using tool" };
      yield {
        kind: "tool_call_start" as const,
        toolName: "browser_navigate",
        callId: toolCallId("c1"),
      };
      yield { kind: "tool_call_delta" as const, callId: toolCallId("c1"), delta: '{"url":"' };
      yield {
        kind: "tool_call_delta" as const,
        callId: toolCallId("c1"),
        delta: 'https://example.com"}',
      };
      yield { kind: "tool_call_end" as const, callId: toolCallId("c1") };
      yield { kind: "usage" as const, inputTokens: 20, outputTokens: 10 };
      yield {
        kind: "done" as const,
        response: {
          content: "Using tool",
          model: "test-model",
          usage: { inputTokens: 20, outputTokens: 10 },
        },
      };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    // toolcall_end event should be emitted
    const toolEndEvents = events.filter((e) => e.type === "toolcall_end");
    expect(toolEndEvents).toHaveLength(1);

    // final done message should include the tool call in content
    const doneEvents = events.filter((e) => e.type === "done");
    expect(doneEvents).toHaveLength(1);
    if (doneEvents[0]?.type === "done") {
      const content = doneEvents[0].message.content;
      const toolCalls = content.filter((c) => c.type === "toolCall");
      expect(toolCalls).toHaveLength(1);
      if (toolCalls[0]?.type === "toolCall") {
        expect(toolCalls[0].id).toBe("c1");
        expect(toolCalls[0].name).toBe("browser_navigate");
        expect(toolCalls[0].arguments).toEqual({ url: "https://example.com" });
      }
    }
  });

  test("handles multiple tool calls in one turn", async () => {
    const mockModelStream: ModelStreamHandler = async function* (_request: ModelRequest) {
      yield { kind: "tool_call_start" as const, toolName: "tool_a", callId: toolCallId("a1") };
      yield { kind: "tool_call_delta" as const, callId: toolCallId("a1"), delta: '{"x":1}' };
      yield { kind: "tool_call_end" as const, callId: toolCallId("a1") };
      yield { kind: "tool_call_start" as const, toolName: "tool_b", callId: toolCallId("b2") };
      yield { kind: "tool_call_delta" as const, callId: toolCallId("b2"), delta: '{"y":2}' };
      yield { kind: "tool_call_end" as const, callId: toolCallId("b2") };
      yield {
        kind: "done" as const,
        response: { content: "", model: "test", usage: { inputTokens: 0, outputTokens: 0 } },
      };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    const doneEvent = events.find((e) => e.type === "done");
    if (doneEvent?.type === "done") {
      const toolCalls = doneEvent.message.content.filter((c) => c.type === "toolCall");
      expect(toolCalls).toHaveLength(2);
      expect(toolCalls[0]?.name).toBe("tool_a");
      expect(toolCalls[1]?.name).toBe("tool_b");
    }
  });

  test("handles malformed JSON in tool call delta with empty args", async () => {
    const mockModelStream: ModelStreamHandler = async function* (_request: ModelRequest) {
      yield { kind: "tool_call_start" as const, toolName: "my_tool", callId: toolCallId("x1") };
      yield { kind: "tool_call_delta" as const, callId: toolCallId("x1"), delta: "not-valid-json" };
      yield { kind: "tool_call_end" as const, callId: toolCallId("x1") };
      yield {
        kind: "done" as const,
        response: { content: "", model: "test", usage: { inputTokens: 0, outputTokens: 0 } },
      };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    const doneEvent = events.find((e) => e.type === "done");
    if (doneEvent?.type === "done") {
      const toolCalls = doneEvent.message.content.filter((c) => c.type === "toolCall");
      expect(toolCalls).toHaveLength(1);
      if (toolCalls[0]?.type === "toolCall") {
        expect(toolCalls[0].arguments).toEqual({});
      }
    }
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

  test("finalize threads cache/cost into AssistantMessage usage", async () => {
    const mockModelStream: ModelStreamHandler = async function* (_request: ModelRequest) {
      yield { kind: "text_delta" as const, delta: "hello" };
      yield { kind: "usage" as const, inputTokens: 100, outputTokens: 50 };
      yield {
        kind: "done" as const,
        response: {
          content: "hello",
          model: "test-model",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    const doneEvent = events.find((e) => e.type === "done");
    if (doneEvent?.type === "done") {
      // Default usage: cache fields are zero since mock stream doesn't populate side-channel
      expect(doneEvent.message.usage.input).toBe(100);
      expect(doneEvent.message.usage.output).toBe(50);
      expect(doneEvent.message.usage.cacheRead).toBe(0);
      expect(doneEvent.message.usage.cacheWrite).toBe(0);
    } else {
      throw new Error("Expected done event");
    }
  });

  test("cache/cost side-channel flows from terminal into AssistantMessage usage", async () => {
    // Use real model-terminal so the side-channel is exercised end-to-end.
    // The mock modelStream simulates what the real terminal does: reads piParams from
    // the store, writes cache/cost to cacheResult, then yields chunks.
    const mockModelStream: ModelStreamHandler = async function* (request: ModelRequest) {
      // Simulate terminal: read piParams (and cacheResult) from nonce store
      const nonce = request.metadata?.[PI_PARAMS_NONCE_KEY] as string | undefined;
      const piParams = nonce !== undefined ? piParamsStore.get(nonce) : undefined;

      // Write cache/cost to the side-channel as the real terminal would from pi done
      if (piParams?.cacheResult !== undefined) {
        piParams.cacheResult.cacheReadTokens = 200;
        piParams.cacheResult.cacheCreationTokens = 50;
        piParams.cacheResult.cost = {
          input: 0.003,
          output: 0.015,
          cacheRead: 0.0003,
          cacheWrite: 0.00375,
          total: 0.02205,
        };
      }

      yield { kind: "usage" as const, inputTokens: 100, outputTokens: 50 };
      yield {
        kind: "done" as const,
        response: {
          content: "cached response",
          model: "test-model",
          usage: { inputTokens: 100, outputTokens: 50 },
        },
      };
    };

    const realStreamSimple: StreamFn = () => createAssistantMessageEventStream();

    const bridgeFn = createBridgeStreamFn(mockModelStream, realStreamSimple);
    const stream = bridgeFn(makeModel(), makeContext());
    const events = await collectStreamEvents(stream);

    const doneEvent = events.find((e) => e.type === "done");
    if (doneEvent?.type === "done") {
      expect(doneEvent.message.usage.input).toBe(100);
      expect(doneEvent.message.usage.output).toBe(50);
      expect(doneEvent.message.usage.cacheRead).toBe(200);
      expect(doneEvent.message.usage.cacheWrite).toBe(50);
      expect(doneEvent.message.usage.cost.total).toBeCloseTo(0.02205);
    } else {
      throw new Error("Expected done event");
    }
  });
});

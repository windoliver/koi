import { describe, expect, test } from "bun:test";
import { toolCallId } from "@koi/core/ecs";
import type { ModelChunk, ModelRequest } from "@koi/core/middleware";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { PiNativeParams } from "./model-terminal.js";
import {
  assistantEventToModelChunk,
  createModelCallTerminal,
  createModelStreamTerminal,
  piParamsStore,
} from "./model-terminal.js";

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

function createMockBoundStream(events: readonly AssistantMessageEvent[]) {
  return (): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      for (const event of events) {
        stream.push(event);
      }
      const lastEvent = events[events.length - 1];
      if (lastEvent?.type === "done") {
        stream.end(lastEvent.message);
      } else if (lastEvent?.type === "error") {
        stream.end(lastEvent.error);
      } else {
        stream.end(makePartialMessage());
      }
    });
    return stream;
  };
}

function makeRequest(
  piParams: Partial<PiNativeParams>,
  overrides?: Partial<ModelRequest>,
): ModelRequest {
  const request: ModelRequest = {
    messages: [],
    model: "test-model",
    ...overrides,
  };
  piParamsStore.set(request, {
    callBoundStream: piParams.callBoundStream ?? (() => createAssistantMessageEventStream()),
    ...piParams,
  });
  return request;
}

async function collectChunks(iter: AsyncIterable<ModelChunk>): Promise<readonly ModelChunk[]> {
  const chunks: ModelChunk[] = [];
  for await (const chunk of iter) {
    chunks.push(chunk);
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// assistantEventToModelChunk
// ---------------------------------------------------------------------------

describe("assistantEventToModelChunk", () => {
  test("maps text_delta", () => {
    const chunk = assistantEventToModelChunk({
      type: "text_delta",
      contentIndex: 0,
      delta: "hello",
      partial: makePartialMessage(),
    });
    expect(chunk).toEqual({ kind: "text_delta", delta: "hello" });
  });

  test("maps thinking_delta", () => {
    const chunk = assistantEventToModelChunk({
      type: "thinking_delta",
      contentIndex: 0,
      delta: "reasoning...",
      partial: makePartialMessage(),
    });
    expect(chunk).toEqual({ kind: "thinking_delta", delta: "reasoning..." });
  });

  test("maps toolcall_start", () => {
    const partial = makePartialMessage({
      content: [{ type: "toolCall", id: "tc-1", name: "search", arguments: {} }],
    });
    const chunk = assistantEventToModelChunk({
      type: "toolcall_start",
      contentIndex: 0,
      partial,
    });
    expect(chunk).toEqual({
      kind: "tool_call_start",
      toolName: "search",
      callId: toolCallId("tc-1"),
    });
  });

  test("returns undefined for toolcall_start with missing tool call", () => {
    const chunk = assistantEventToModelChunk({
      type: "toolcall_start",
      contentIndex: 5,
      partial: makePartialMessage(),
    });
    expect(chunk).toBeUndefined();
  });

  test("maps toolcall_start at contentIndex 1 when thinking block is at index 0", () => {
    // Simulates thinking(index=0) + tool_use(index=1) — contentIndex is raw Anthropic block index
    const partial = makePartialMessage({
      content: [
        { type: "thinking", thinking: "I should call the tool" } as unknown as {
          type: string;
        },
        { type: "toolCall", id: "tc-42", name: "browser_navigate", arguments: {} },
      ] as AssistantMessage["content"],
    });
    const chunk = assistantEventToModelChunk({
      type: "toolcall_start",
      contentIndex: 1,
      partial,
    });
    expect(chunk).toEqual({
      kind: "tool_call_start",
      toolName: "browser_navigate",
      callId: toolCallId("tc-42"),
    });
  });

  test("maps toolcall_delta at contentIndex 1 when thinking block is at index 0", () => {
    const partial = makePartialMessage({
      content: [
        { type: "thinking", thinking: "..." } as unknown as { type: string },
        { type: "toolCall", id: "tc-42", name: "browser_navigate", arguments: {} },
      ] as AssistantMessage["content"],
    });
    const chunk = assistantEventToModelChunk({
      type: "toolcall_delta",
      contentIndex: 1,
      delta: '{"url":',
      partial,
    });
    expect(chunk).toEqual({
      kind: "tool_call_delta",
      callId: toolCallId("tc-42"),
      delta: '{"url":',
    });
  });

  test("maps toolcall_delta with callId from partial content", () => {
    const partial = makePartialMessage({
      content: [{ type: "toolCall", id: "tc-1", name: "search", arguments: {} }],
    });
    const chunk = assistantEventToModelChunk({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"q":',
      partial,
    });
    expect(chunk).toEqual({ kind: "tool_call_delta", callId: toolCallId("tc-1"), delta: '{"q":' });
  });

  test("maps toolcall_delta with empty callId when tool call missing", () => {
    const chunk = assistantEventToModelChunk({
      type: "toolcall_delta",
      contentIndex: 0,
      delta: '{"q":',
      partial: makePartialMessage(),
    });
    expect(chunk).toEqual({ kind: "tool_call_delta", callId: toolCallId(""), delta: '{"q":' });
  });

  test("maps toolcall_end", () => {
    const chunk = assistantEventToModelChunk({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "tc-1", name: "search", arguments: { q: "test" } },
      partial: makePartialMessage(),
    });
    expect(chunk).toEqual({ kind: "tool_call_end", callId: toolCallId("tc-1") });
  });

  test("maps done to usage", () => {
    const msg = makePartialMessage({
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const chunk = assistantEventToModelChunk({
      type: "done",
      reason: "stop",
      message: msg,
    });
    expect(chunk).toEqual({ kind: "usage", inputTokens: 100, outputTokens: 50 });
  });

  test("maps error to usage", () => {
    const errMsg = makePartialMessage({
      usage: {
        input: 30,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 35,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const chunk = assistantEventToModelChunk({
      type: "error",
      reason: "error",
      error: errMsg,
    });
    expect(chunk).toEqual({ kind: "usage", inputTokens: 30, outputTokens: 5 });
  });

  test("returns undefined for start event", () => {
    const chunk = assistantEventToModelChunk({
      type: "start",
      partial: makePartialMessage(),
    });
    expect(chunk).toBeUndefined();
  });

  test("returns undefined for text_start event", () => {
    const chunk = assistantEventToModelChunk({
      type: "text_start",
      contentIndex: 0,
      partial: makePartialMessage(),
    });
    expect(chunk).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createModelStreamTerminal
// ---------------------------------------------------------------------------

describe("createModelStreamTerminal", () => {
  test("streams text_delta chunks from pi events", async () => {
    const streamTerminal = createModelStreamTerminal();
    const events: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "hello ", partial: makePartialMessage() },
      { type: "text_delta", contentIndex: 0, delta: "world", partial: makePartialMessage() },
      {
        type: "done",
        reason: "stop",
        message: makePartialMessage({
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ];

    const request = makeRequest({
      callBoundStream: createMockBoundStream(events),
    });

    const chunks = await collectChunks(streamTerminal(request));
    const textDeltas = chunks.filter((c) => c.kind === "text_delta");
    expect(textDeltas).toHaveLength(2);

    const doneChunk = chunks.find((c) => c.kind === "done");
    expect(doneChunk?.kind).toBe("done");
    if (doneChunk?.kind === "done") {
      expect(doneChunk.response.content).toBe("hello world");
      expect(doneChunk.response.model).toBe("test-model");
    }
  });

  test("throws when pi params are missing", async () => {
    const streamTerminal = createModelStreamTerminal();
    const request: ModelRequest = { messages: [] };

    try {
      for await (const _chunk of streamTerminal(request)) {
        // should not reach here
      }
      expect(true).toBe(false); // should have thrown
    } catch (e: unknown) {
      expect((e as Error).message).toContain("pi-native params");
    }
  });

  test("falls back to piParams.temperature/maxTokens when request lacks them", async () => {
    const streamTerminal = createModelStreamTerminal();
    let capturedOptions: Record<string, unknown> | undefined;

    const events: AssistantMessageEvent[] = [
      {
        type: "done",
        reason: "stop",
        message: makePartialMessage({
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ];

    const mockBoundStream = (options?: Record<string, unknown>) => {
      capturedOptions = options;
      return createMockBoundStream(events)();
    };

    const request = makeRequest({
      callBoundStream: mockBoundStream,
      temperature: 0.3,
      maxTokens: 512,
      apiKey: "test-key",
      reasoning: "high",
      signal: new AbortController().signal,
    });
    const chunks = await collectChunks(streamTerminal(request));
    expect(chunks.length).toBeGreaterThan(0);

    expect(capturedOptions?.temperature).toBe(0.3);
    expect(capturedOptions?.maxTokens).toBe(512);
    expect(capturedOptions?.apiKey).toBe("test-key");
    expect(capturedOptions?.reasoning).toBe("high");
  });

  test("includes usage chunk from done event", async () => {
    const streamTerminal = createModelStreamTerminal();
    const events: AssistantMessageEvent[] = [
      {
        type: "done",
        reason: "stop",
        message: makePartialMessage({
          usage: {
            input: 100,
            output: 50,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 150,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ];

    const request = makeRequest({ callBoundStream: createMockBoundStream(events) });
    const chunks = await collectChunks(streamTerminal(request));
    const usageChunk = chunks.find((c) => c.kind === "usage");
    expect(usageChunk).toEqual({ kind: "usage", inputTokens: 100, outputTokens: 50 });
  });
});

// ---------------------------------------------------------------------------
// createModelCallTerminal
// ---------------------------------------------------------------------------

describe("createModelCallTerminal", () => {
  test("collects stream into single ModelResponse", async () => {
    const streamTerminal = createModelStreamTerminal();
    const callTerminal = createModelCallTerminal(streamTerminal);

    const events: AssistantMessageEvent[] = [
      { type: "text_delta", contentIndex: 0, delta: "hello ", partial: makePartialMessage() },
      { type: "text_delta", contentIndex: 0, delta: "world", partial: makePartialMessage() },
      {
        type: "done",
        reason: "stop",
        message: makePartialMessage({
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }),
      },
    ];

    const request = makeRequest({ callBoundStream: createMockBoundStream(events) });
    const response = await callTerminal(request);

    expect(response.content).toBe("hello world");
    expect(response.model).toBe("test-model");
    expect(response.usage?.inputTokens).toBe(10);
    expect(response.usage?.outputTokens).toBe(5);
  });

  test("returns assembled response when done chunk is last", async () => {
    const streamTerminal = createModelStreamTerminal();
    const callTerminal = createModelCallTerminal(streamTerminal);

    const doneMessage = makePartialMessage({
      usage: {
        input: 20,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });

    const events: AssistantMessageEvent[] = [
      { type: "done", reason: "stop", message: doneMessage },
    ];

    const request = makeRequest({ callBoundStream: createMockBoundStream(events) });
    const response = await callTerminal(request);

    expect(response.content).toBe("");
    expect(response.usage?.inputTokens).toBe(20);
  });
});

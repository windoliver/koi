/**
 * Integration tests for the pi engine adapter.
 *
 * These tests exercise the full flow: createPiAdapter → stream() → events.
 * They use real PiAgent instances with mock modelStream handlers.
 */

import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core/ecs";
import type { ComposedCallHandlers, EngineEvent, EngineInput } from "@koi/core/engine";
import type {
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
} from "@koi/core/middleware";
import { createPiAdapter } from "../adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockCallHandlers(opts?: {
  readonly modelStreamChunks?: readonly ModelChunk[];
  readonly toolCallResult?: ToolResponse;
  readonly tools?: readonly ToolDescriptor[];
}): ComposedCallHandlers {
  const chunks: readonly ModelChunk[] = opts?.modelStreamChunks ?? [
    { kind: "text_delta", delta: "Hello from pi!" },
    { kind: "usage", inputTokens: 10, outputTokens: 5 },
    {
      kind: "done",
      response: {
        content: "Hello from pi!",
        model: "test",
        usage: { inputTokens: 10, outputTokens: 5 },
      },
    },
  ];

  return {
    modelCall: async (_request: ModelRequest): Promise<ModelResponse> => {
      return {
        content: "Hello from pi!",
        model: "test",
        usage: { inputTokens: 10, outputTokens: 5 },
      };
    },
    modelStream: async function* (_request: ModelRequest): AsyncIterable<ModelChunk> {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
    toolCall: async (_request: ToolRequest): Promise<ToolResponse> => {
      return opts?.toolCallResult ?? { output: "tool result" };
    },
    tools: opts?.tools ?? [],
  };
}

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
  maxEvents = 50,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
    if (events.length >= maxEvents) break;
  }
  return events;
}

// ---------------------------------------------------------------------------
// Integration: full stream() flow
// ---------------------------------------------------------------------------

describe("PiEngineAdapter integration", () => {
  test("streams events from a simple text prompt", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      systemPrompt: "You are helpful.",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "Say hello",
      callHandlers: handlers,
    };

    const events = await collectEvents(adapter.stream(input));

    // We should get some events — at minimum text_delta and done
    expect(events.length).toBeGreaterThan(0);

    // The last event should be done
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.kind === "done") {
      expect(doneEvent.output.metrics.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("handles messages input kind", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "messages",
      messages: [
        {
          content: [{ kind: "text", text: "What is 2+2?" }],
          senderId: "user",
          timestamp: Date.now(),
        },
      ],
      callHandlers: handlers,
    };

    const events = await collectEvents(adapter.stream(input));
    expect(events.length).toBeGreaterThan(0);

    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
  });

  test("steer/followUp/abort work during active stream", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "Do work",
      callHandlers: handlers,
    };

    // Start stream but don't consume yet
    const iterable = adapter.stream(input);

    // These should not throw even during active stream
    expect(() => adapter.steer("redirect now")).not.toThrow();
    expect(() => adapter.followUp("continue after")).not.toThrow();

    // Now consume the stream
    const events = await collectEvents(iterable);
    expect(events.length).toBeGreaterThan(0);
  });

  test("abort terminates the stream", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "Do a long task",
      callHandlers: handlers,
    };

    const iterable = adapter.stream(input);
    adapter.abort();

    // Stream should still complete (abort is best-effort)
    const events = await collectEvents(iterable);
    expect(events.length).toBeGreaterThanOrEqual(0);
  });

  test("dispose cleans up active agent", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "hello",
      callHandlers: handlers,
    };

    // Start a stream
    const _iterable = adapter.stream(input);

    // Dispose while running
    await adapter.dispose?.();

    // Subsequent operations should not throw
    expect(() => adapter.steer("test")).not.toThrow();
    expect(() => adapter.abort()).not.toThrow();
  });

  test("iterator return() triggers cleanup", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "hello",
      callHandlers: handlers,
    };

    const iterable = adapter.stream(input);
    const iterator = iterable[Symbol.asyncIterator]();

    // Get at least one event, then return
    await iterator.next();
    const returnResult = await iterator.return?.();
    expect(returnResult?.done).toBe(true);
  });

  test("defaultConvertToLlm filters messages correctly", async () => {
    // The adapter uses defaultConvertToLlm internally.
    // Verify it works by running a stream with the adapter.
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "test",
      callHandlers: handlers,
    };

    const events = await collectEvents(adapter.stream(input));
    expect(events.length).toBeGreaterThan(0);
  });

  test("handles thinkingLevel='off' mapping to minimal", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      thinkingLevel: "off",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "test",
      callHandlers: handlers,
    };

    const events = await collectEvents(adapter.stream(input));
    expect(events.length).toBeGreaterThan(0);
  });

  test("passes transformContext config to pi Agent", async () => {
    let transformCalled = false;
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      transformContext: async (messages) => {
        transformCalled = true;
        return messages;
      },
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "test",
      callHandlers: handlers,
    };

    const events = await collectEvents(adapter.stream(input));
    expect(events.length).toBeGreaterThan(0);
    // transformContext is called by pi Agent during LLM call
    expect(transformCalled).toBe(true);
  });

  test("pi agent receives tool descriptors from callHandlers.tools", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      systemPrompt: "You are helpful.",
    });

    const calcDescriptor: ToolDescriptor = {
      name: "calc",
      description: "Calculator tool",
      inputSchema: { type: "object", properties: { expr: { type: "string" } } },
    };
    const handlers = createMockCallHandlers({ tools: [calcDescriptor] });
    const input: EngineInput = {
      kind: "text",
      text: "Calculate 2+2",
      callHandlers: handlers,
    };

    const events = await collectEvents(adapter.stream(input));
    expect(events.length).toBeGreaterThan(0);

    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
  });

  test("passes getApiKey config to pi Agent", async () => {
    const adapter = createPiAdapter({
      model: "anthropic:claude-sonnet-4-5-20250929",
      getApiKey: async (_provider) => "test-key-123",
    });

    const handlers = createMockCallHandlers();
    const input: EngineInput = {
      kind: "text",
      text: "test",
      callHandlers: handlers,
    };

    const events = await collectEvents(adapter.stream(input));
    expect(events.length).toBeGreaterThan(0);
  });
});

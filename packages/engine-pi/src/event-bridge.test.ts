import { describe, expect, test } from "bun:test";
import { toolCallId } from "@koi/core/ecs";
import type { EngineEvent } from "@koi/core/engine";
import type { AgentEvent } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@mariozechner/pi-ai";
import { AsyncQueue, createEventSubscriber, mapStopReason } from "./event-bridge.js";
import { createMetricsAccumulator } from "./metrics.js";

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

function makeMessageUpdate(assistantMessageEvent: AssistantMessageEvent): AgentEvent {
  return {
    type: "message_update",
    message: makePartialMessage(),
    assistantMessageEvent,
  };
}

async function collectEvents(queue: AsyncQueue<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of queue) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// AsyncQueue
// ---------------------------------------------------------------------------

describe("AsyncQueue", () => {
  test("delivers pushed items to consumer", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.end();

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }
    expect(items).toEqual([1, 2]);
  });

  test("consumer blocks until item available", async () => {
    const queue = new AsyncQueue<string>();

    const promise = (async () => {
      const items: string[] = [];
      for await (const item of queue) {
        items.push(item);
      }
      return items;
    })();

    // Push after consumer is waiting
    queue.push("hello");
    queue.end();

    const items = await promise;
    expect(items).toEqual(["hello"]);
  });

  test("ignores pushes after end", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.end();
    queue.push(2); // should be ignored

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }
    expect(items).toEqual([1]);
  });

  test("handles empty queue that is immediately ended", async () => {
    const queue = new AsyncQueue<number>();
    queue.end();

    const items: number[] = [];
    for await (const item of queue) {
      items.push(item);
    }
    expect(items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mapStopReason
// ---------------------------------------------------------------------------

describe("mapStopReason", () => {
  test("maps stop → completed", () => {
    expect(mapStopReason("stop")).toBe("completed");
  });

  test("maps toolUse → completed", () => {
    expect(mapStopReason("toolUse")).toBe("completed");
  });

  test("maps length → max_turns", () => {
    expect(mapStopReason("length")).toBe("max_turns");
  });

  test("maps error → error", () => {
    expect(mapStopReason("error")).toBe("error");
  });

  test("maps aborted → interrupted", () => {
    expect(mapStopReason("aborted")).toBe("interrupted");
  });
});

// ---------------------------------------------------------------------------
// createEventSubscriber
// ---------------------------------------------------------------------------

describe("createEventSubscriber", () => {
  test("maps text_delta message_update to text_delta event", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    subscriber(
      makeMessageUpdate({
        type: "text_delta",
        contentIndex: 0,
        delta: "hello",
        partial: makePartialMessage(),
      }),
    );
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({ kind: "text_delta", delta: "hello" });
  });

  test("maps thinking_delta to custom event", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    subscriber(
      makeMessageUpdate({
        type: "thinking_delta",
        contentIndex: 0,
        delta: "reasoning...",
        partial: makePartialMessage(),
      }),
    );
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({
      kind: "custom",
      type: "thinking_delta",
      data: { delta: "reasoning..." },
    });
  });

  test("maps toolcall_delta to tool_call_delta event", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    const partial = makePartialMessage({
      content: [{ type: "toolCall", id: "call-1", name: "search", arguments: {} }],
    });

    subscriber(
      makeMessageUpdate({
        type: "toolcall_delta",
        contentIndex: 0,
        delta: '{"query":"test"}',
        partial,
      }),
    );
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({
      kind: "tool_call_delta",
      callId: toolCallId("call-1"),
      delta: '{"query":"test"}',
    });
  });

  test("maps toolcall_start to tool_call_start event", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    const partial = makePartialMessage({
      content: [{ type: "toolCall", id: "call-1", name: "search", arguments: {} }],
    });

    subscriber(
      makeMessageUpdate({
        type: "toolcall_start",
        contentIndex: 0,
        partial,
      }),
    );
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({
      kind: "tool_call_start",
      toolName: "search",
      callId: toolCallId("call-1"),
      args: {},
    });
  });

  test("resolves toolcall_start at contentIndex 1 when thinking block at index 0", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    // Simulates thinking(index=0) + tool_use(index=1) — raw Anthropic block ordering
    const partial = makePartialMessage({
      content: [
        { type: "thinking", thinking: "I should use the tool" } as unknown as {
          type: string;
        },
        { type: "toolCall", id: "call-99", name: "browser_navigate", arguments: {} },
      ] as AssistantMessage["content"],
    });

    subscriber(
      makeMessageUpdate({
        type: "toolcall_start",
        contentIndex: 1,
        partial,
      }),
    );
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({
      kind: "tool_call_start",
      toolName: "browser_navigate",
      callId: toolCallId("call-99"),
      args: {},
    });
  });

  test("resolves toolcall_delta callId at contentIndex 1 when thinking block at index 0", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    const partial = makePartialMessage({
      content: [
        { type: "thinking", thinking: "..." } as unknown as { type: string },
        { type: "toolCall", id: "call-99", name: "browser_navigate", arguments: {} },
      ] as AssistantMessage["content"],
    });

    subscriber(
      makeMessageUpdate({
        type: "toolcall_delta",
        contentIndex: 1,
        delta: '{"url":"https://example.com"}',
        partial,
      }),
    );
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({
      kind: "tool_call_delta",
      callId: toolCallId("call-99"),
      delta: '{"url":"https://example.com"}',
    });
  });

  test("deduplicates tool_call_start between toolcall_start and tool_execution_start", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    const partial = makePartialMessage({
      content: [{ type: "toolCall", id: "call-1", name: "search", arguments: {} }],
    });

    // First: toolcall_start via message_update
    subscriber(
      makeMessageUpdate({
        type: "toolcall_start",
        contentIndex: 0,
        partial,
      }),
    );

    // Second: tool_execution_start (should be deduplicated)
    subscriber({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "search",
      args: {},
    });

    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    const toolStarts = events.filter((e) => e.kind === "tool_call_start");
    expect(toolStarts).toHaveLength(1);
  });

  test("emits tool_call_start from tool_execution_start if not already emitted", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    // tool_execution_start without prior toolcall_start
    subscriber({
      type: "tool_execution_start",
      toolCallId: "call-2",
      toolName: "write",
      args: {},
    });
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({
      kind: "tool_call_start",
      toolName: "write",
      callId: toolCallId("call-2"),
      args: {},
    });
  });

  test("maps tool_execution_end to tool_call_end event", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    subscriber({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "search",
      result: { text: "found it" },
      isError: false,
    });
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({
      kind: "tool_call_end",
      callId: toolCallId("call-1"),
      result: { text: "found it" },
    });
  });

  test("maps turn_end to turn_end event with incrementing index and accumulates usage", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    const msg1 = makePartialMessage({
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const msg2 = makePartialMessage({
      usage: {
        input: 20,
        output: 8,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 28,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    subscriber({ type: "turn_end", message: msg1, toolResults: [] });
    subscriber({ type: "turn_end", message: msg2, toolResults: [] });
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    expect(events[0]).toEqual({ kind: "turn_end", turnIndex: 0 });
    expect(events[1]).toEqual({ kind: "turn_end", turnIndex: 1 });

    const doneEvent = events.find((e) => e.kind === "done");
    if (doneEvent?.kind === "done") {
      expect(doneEvent.output.metrics.inputTokens).toBe(30);
      expect(doneEvent.output.metrics.outputTokens).toBe(13);
      expect(doneEvent.output.metrics.turns).toBe(2);
    }
  });

  test("maps agent_end to done event with metrics", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    // Pi fires turn_end with the final AssistantMessage — usage comes from event.message.usage.
    // This is the real pi behavior: message_update { type: "done" } is never fired.
    const turnMsg = makePartialMessage({
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    subscriber({
      type: "turn_end",
      message: turnMsg,
      toolResults: [],
    });

    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.kind === "done") {
      expect(doneEvent.output.stopReason).toBe("completed");
      expect(doneEvent.output.metrics.inputTokens).toBe(100);
      expect(doneEvent.output.metrics.outputTokens).toBe(50);
      expect(doneEvent.output.metrics.totalTokens).toBe(150);
      expect(doneEvent.output.metrics.turns).toBe(1);
    }
  });

  test("accumulates usage from turn_end events across turns", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    // Real pi fires turn_end (not message_update { type: "done" }) with per-turn usage.
    const msg1 = makePartialMessage({
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    subscriber({ type: "turn_end", message: msg1, toolResults: [] });

    const msg2 = makePartialMessage({
      usage: {
        input: 200,
        output: 80,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 280,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    subscriber({ type: "turn_end", message: msg2, toolResults: [] });

    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    const doneEvent = events.find((e) => e.kind === "done");
    if (doneEvent?.kind === "done") {
      expect(doneEvent.output.metrics.inputTokens).toBe(300);
      expect(doneEvent.output.metrics.outputTokens).toBe(130);
    }
  });

  test("also accumulates usage from error events", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    const errMsg = makePartialMessage({
      usage: {
        input: 50,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 60,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    subscriber(makeMessageUpdate({ type: "error", reason: "error", error: errMsg }));

    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    const doneEvent = events.find((e) => e.kind === "done");
    if (doneEvent?.kind === "done") {
      expect(doneEvent.output.metrics.inputTokens).toBe(50);
      expect(doneEvent.output.metrics.outputTokens).toBe(10);
    }
  });

  test("filters irrelevant events (agent_start, turn_start, etc.)", async () => {
    const queue = new AsyncQueue<EngineEvent>();
    const metrics = createMetricsAccumulator();
    const subscriber = createEventSubscriber(queue, metrics);

    subscriber({ type: "agent_start" });
    subscriber({ type: "turn_start" });
    subscriber({
      type: "message_start",
      message: makePartialMessage(),
    });
    subscriber({
      type: "message_end",
      message: makePartialMessage(),
    });
    subscriber({ type: "agent_end", messages: [] });

    const events = await collectEvents(queue);
    // Only agent_end → done event
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("done");
  });
});

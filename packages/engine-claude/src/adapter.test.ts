import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput } from "@koi/core";
import type { SdkFunctions, SdkQuery } from "./adapter.js";
import { createClaudeAdapter } from "./adapter.js";
import type { SdkMessage } from "./event-map.js";
import type { ClaudeAdapterConfig } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectEvents(
  iterable: AsyncIterable<EngineEvent>,
): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function findDoneOutput(events: readonly EngineEvent[]): EngineOutput | undefined {
  const done = events.find((e): e is EngineEvent & { readonly kind: "done" } => e.kind === "done");
  return done?.output;
}

/**
 * Create a mock SDK that yields the given messages.
 */
function createMockSdk(messages: readonly SdkMessage[]): SdkFunctions {
  return {
    query: async function* (_params: { prompt: string }) {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

/**
 * Create an SDK init system message.
 */
function initMessage(sessionId: string): SdkMessage {
  return { type: "system", subtype: "init", session_id: sessionId };
}

/**
 * Create an SDK result message.
 */
function resultMessage(
  subtype: string,
  overrides?: Partial<{
    result: string;
    session_id: string;
    num_turns: number;
    duration_ms: number;
    usage: { input_tokens: number; output_tokens: number };
  }>,
): SdkMessage {
  return {
    type: "result",
    subtype,
    result: overrides?.result ?? "Done",
    session_id: overrides?.session_id ?? "sess-1",
    num_turns: overrides?.num_turns ?? 1,
    duration_ms: overrides?.duration_ms ?? 100,
    usage: overrides?.usage ?? { input_tokens: 10, output_tokens: 5 },
  };
}

/**
 * Create an SDK assistant message.
 */
function assistantMessage(
  content: readonly {
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }[],
): SdkMessage {
  return {
    type: "assistant",
    message: { content },
  };
}

// ---------------------------------------------------------------------------
// Core adapter behavior
// ---------------------------------------------------------------------------

describe("createClaudeAdapter", () => {
  test("returns adapter with correct engineId", () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    expect(adapter.engineId).toBe("claude");
  });

  test("has no terminals (non-cooperating adapter)", () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    expect(adapter.terminals).toBeUndefined();
  });
});

describe("stream", () => {
  test("yields events from SDK messages", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      assistantMessage([{ type: "text", text: "Hello!" }]),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Hi" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas.length).toBeGreaterThanOrEqual(1);

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });

  test("emits done event on SDK result", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      resultMessage("success", {
        result: "Task complete",
        num_turns: 3,
        duration_ms: 5000,
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Do something" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
    expect(output?.metrics.inputTokens).toBe(100);
    expect(output?.metrics.outputTokens).toBe(50);
    expect(output?.metrics.turns).toBe(3);
  });

  test("captures session ID from init message", async () => {
    const sdk = createMockSdk([
      initMessage("sess-abc-123"),
      resultMessage("success", { session_id: "sess-abc-123" }),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Hello" }));

    const state = await adapter.saveState?.();
    expect(state).toBeDefined();
    const data = state?.data as { sessionId: string };
    expect(data.sessionId).toBe("sess-abc-123");
  });

  test("handles messages input kind", async () => {
    const sdk = createMockSdk([initMessage("sess-1"), resultMessage("success")]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(
      adapter.stream({
        kind: "messages",
        messages: [
          {
            content: [{ kind: "text", text: "Hello" }],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      }),
    );

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("completed");
  });

  test("emits synthetic done when SDK yields no events", async () => {
    const sdk = createMockSdk([]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Hello" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("error");
  });

  test("emits error done when SDK throws", async () => {
    const sdk: SdkFunctions = {
      // biome-ignore lint/correctness/useYield: intentionally throws before yielding
      query: async function* () {
        throw new Error("SDK connection failed");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Hello" }));

    const output = findDoneOutput(events);
    expect(output).toBeDefined();
    expect(output?.stopReason).toBe("error");
    expect(output?.metadata?.error).toBe("SDK connection failed");
  });

  test("maps error_max_budget_usd to interrupted stop reason", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      resultMessage("error_max_budget_usd", {
        usage: { input_tokens: 50000, output_tokens: 20000 },
      }),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Expensive task" }));

    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("interrupted");
  });

  test("maps error_max_turns to max_turns stop reason", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      resultMessage("error_max_turns", { num_turns: 25 }),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Long task" }));

    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("max_turns");
  });
});

// ---------------------------------------------------------------------------
// Turn tracking
// ---------------------------------------------------------------------------

describe("turn tracking", () => {
  test("emits turn_end between assistant→user→assistant sequences", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      // Turn 0: assistant with tool call
      assistantMessage([
        { type: "text", text: "Let me search." },
        { type: "tool_use", id: "call-1", name: "search", input: { q: "test" } },
      ]),
      // User message with tool result → triggers turn_end
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "Found results" }],
        },
      } as SdkMessage,
      // Turn 1: final assistant response
      assistantMessage([{ type: "text", text: "Here are the results." }]),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Search" }));

    const turnEnds = events.filter(
      (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
    );
    expect(turnEnds).toHaveLength(1);
    expect(turnEnds[0]?.turnIndex).toBe(0);
  });

  test("increments turnIndex across multiple turns", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      // Turn 0
      assistantMessage([{ type: "tool_use", id: "call-1", name: "search", input: { q: "a" } }]),
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call-1", content: "result A" }],
        },
      } as SdkMessage,
      // Turn 1
      assistantMessage([{ type: "tool_use", id: "call-2", name: "read", input: { path: "x" } }]),
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "call-2", content: "result B" }],
        },
      } as SdkMessage,
      // Final response
      assistantMessage([{ type: "text", text: "Done." }]),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Multi-turn" }));

    const turnEnds = events.filter(
      (e): e is EngineEvent & { readonly kind: "turn_end" } => e.kind === "turn_end",
    );
    expect(turnEnds).toHaveLength(2);
    expect(turnEnds[0]?.turnIndex).toBe(0);
    expect(turnEnds[1]?.turnIndex).toBe(1);
  });

  test("does not emit turn_end for text-only conversations", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      assistantMessage([{ type: "text", text: "Hello!" }]),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Hi" }));

    const turnEnds = events.filter((e) => e.kind === "turn_end");
    expect(turnEnds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Concurrent run guard
// ---------------------------------------------------------------------------

describe("concurrent run guard", () => {
  test("throws when a second stream is started while first is running", async () => {
    let resolveQuery: (() => void) | undefined;

    const sdk: SdkFunctions = {
      query: async function* () {
        await new Promise<void>((r) => {
          resolveQuery = r;
        });
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    // Start the first run
    const firstRun = adapter.stream({ kind: "text", text: "first" });
    const iterator = firstRun[Symbol.asyncIterator]();
    const firstNext = iterator.next();

    // Attempt a second run
    await expect(collectEvents(adapter.stream({ kind: "text", text: "second" }))).rejects.toThrow(
      "concurrent",
    );

    // Cleanup
    resolveQuery?.();
    await firstNext;
    let done = false;
    while (!done) {
      const result = await iterator.next();
      done = result.done ?? false;
    }
  });

  test("allows sequential runs after first completes", async () => {
    const sdk = createMockSdk([initMessage("sess-1"), resultMessage("success")]);

    const adapter = createClaudeAdapter({}, sdk);

    const events1 = await collectEvents(adapter.stream({ kind: "text", text: "first" }));
    expect(findDoneOutput(events1)?.stopReason).toBe("completed");

    const events2 = await collectEvents(adapter.stream({ kind: "text", text: "second" }));
    expect(findDoneOutput(events2)?.stopReason).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

describe("saveState and loadState", () => {
  test("saveState returns state with correct engineId", async () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    const state = await adapter.saveState?.();
    expect(state?.engineId).toBe("claude");
  });

  test("saveState returns session ID in EngineState", async () => {
    const sdk = createMockSdk([
      initMessage("sess-saved"),
      resultMessage("success", { session_id: "sess-saved" }),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Hello" }));

    const state = await adapter.saveState?.();
    const data = state?.data as { sessionId: string };
    expect(data.sessionId).toBe("sess-saved");
  });

  test("loadState stores session ID for resume", async () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    await adapter.loadState?.({
      engineId: "claude",
      data: { sessionId: "sess-loaded" },
    });

    const state = await adapter.saveState?.();
    const data = state?.data as { sessionId: string };
    expect(data.sessionId).toBe("sess-loaded");
  });

  test("loadState rejects state from different engine", async () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    await expect(adapter.loadState?.({ engineId: "other-engine", data: {} })).rejects.toThrow(
      "Cannot load state",
    );
  });

  test("stream with resume kind uses stored session ID", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: { prompt: string; options?: Record<string, unknown> }) {
        capturedOptions = params.options;
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await adapter.loadState?.({
      engineId: "claude",
      data: { sessionId: "sess-resume" },
    });

    await collectEvents(
      adapter.stream({
        kind: "resume",
        state: { engineId: "claude", data: { sessionId: "sess-resume" } },
      }),
    );

    expect(capturedOptions?.resume).toBe("sess-resume");
  });
});

// ---------------------------------------------------------------------------
// Dispose
// ---------------------------------------------------------------------------

describe("dispose", () => {
  test("dispose can be called without error", async () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    await adapter.dispose?.();
  });

  test("dispose is idempotent", async () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    await adapter.dispose?.();
    await adapter.dispose?.();
    await adapter.dispose?.();
  });

  test("stream after dispose emits interrupted stop reason", async () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    await adapter.dispose?.();

    const events = await collectEvents(adapter.stream({ kind: "text", text: "After dispose" }));

    const output = findDoneOutput(events);
    expect(output?.stopReason).toBe("interrupted");
  });

  test("dispose aborts active query", async () => {
    let aborted = false;

    const sdk: SdkFunctions = {
      query: async function* (params: { prompt: string; options?: Record<string, unknown> }) {
        const controller = params.options?.abortController as AbortController | undefined;
        controller?.signal.addEventListener("abort", () => {
          aborted = true;
        });
        // Simulate a long-running query
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    // Start streaming in the background
    const streamPromise = collectEvents(adapter.stream({ kind: "text", text: "Long task" }));

    // Dispose while streaming
    await new Promise<void>((r) => setTimeout(r, 10));
    await adapter.dispose?.();

    // Wait for stream to complete
    await streamPromise;

    expect(aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Config integration
// ---------------------------------------------------------------------------

describe("config integration", () => {
  test("sdkOverrides take precedence over derived config", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: { prompt: string; options?: Record<string, unknown> }) {
        capturedOptions = params.options;
        yield resultMessage("success");
      },
    };

    const config: ClaudeAdapterConfig = {
      model: "claude-sonnet-4-5-20250929",
      sdkOverrides: { model: "claude-opus-4-6" },
    };

    const adapter = createClaudeAdapter(config, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    expect(capturedOptions?.model).toBe("claude-opus-4-6");
  });
});

// ---------------------------------------------------------------------------
// Controls lifecycle
// ---------------------------------------------------------------------------

describe("controls", () => {
  test("controls is undefined when not streaming", () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    expect(adapter.controls).toBeUndefined();
  });

  test("controls is available during streaming", async () => {
    let resolveQuery: (() => void) | undefined;

    const sdk: SdkFunctions = {
      query: async function* () {
        await new Promise<void>((r) => {
          resolveQuery = r;
        });
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    // Start streaming in background
    const stream = adapter.stream({ kind: "text", text: "Hi" });
    const iterator = stream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    // Give the async generator a tick to start
    await new Promise<void>((r) => setTimeout(r, 10));

    // Capture controls while stream is active
    const controlsDuringStream = adapter.controls;

    // Cleanup
    resolveQuery?.();
    await nextPromise;
    let done = false;
    while (!done) {
      const result = await iterator.next();
      done = result.done ?? false;
    }

    expect(controlsDuringStream).toBeDefined();
  });

  test("controls is undefined after streaming completes", async () => {
    const sdk = createMockSdk([initMessage("sess-1"), resultMessage("success")]);

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Hi" }));

    expect(adapter.controls).toBeUndefined();
  });

  test("interrupt delegates to query's interrupt method", async () => {
    let interruptCalled = false;
    let resolveQuery: (() => void) | undefined;

    const sdk: SdkFunctions = {
      query: (_params: { prompt: string }): SdkQuery => {
        const iterable: SdkQuery = {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((r) => {
              resolveQuery = r;
            });
            yield resultMessage("success");
          },
          interrupt: async () => {
            interruptCalled = true;
          },
        };
        return iterable;
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    // Start streaming
    const stream = adapter.stream({ kind: "text", text: "Hi" });
    const iterator = stream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    await new Promise<void>((r) => setTimeout(r, 10));

    // Call interrupt via controls
    await adapter.controls?.interrupt();

    // Cleanup
    resolveQuery?.();
    await nextPromise;
    let done = false;
    while (!done) {
      const result = await iterator.next();
      done = result.done ?? false;
    }

    expect(interruptCalled).toBe(true);
  });

  test("setModel delegates to query's setModel method", async () => {
    let capturedModel: string | undefined;
    let resolveQuery: (() => void) | undefined;

    const sdk: SdkFunctions = {
      query: (_params: { prompt: string }): SdkQuery => {
        const iterable: SdkQuery = {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((r) => {
              resolveQuery = r;
            });
            yield resultMessage("success");
          },
          setModel: async (model?: string) => {
            capturedModel = model;
          },
        };
        return iterable;
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    const stream = adapter.stream({ kind: "text", text: "Hi" });
    const iterator = stream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    await new Promise<void>((r) => setTimeout(r, 10));

    await adapter.controls?.setModel("claude-opus-4-6");

    resolveQuery?.();
    await nextPromise;
    let done = false;
    while (!done) {
      const result = await iterator.next();
      done = result.done ?? false;
    }

    expect(capturedModel).toBe("claude-opus-4-6");
  });

  test("controls methods are no-ops when query has no control methods", async () => {
    let resolveQuery: (() => void) | undefined;

    // Mock SDK returns plain AsyncIterable with no control methods
    const sdk: SdkFunctions = {
      query: async function* () {
        await new Promise<void>((r) => {
          resolveQuery = r;
        });
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    const stream = adapter.stream({ kind: "text", text: "Hi" });
    const iterator = stream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    await new Promise<void>((r) => setTimeout(r, 10));

    // Should not throw — gracefully no-ops
    await adapter.controls?.interrupt();
    await adapter.controls?.setModel("test");
    await adapter.controls?.setPermissionMode("default");
    await adapter.controls?.stopTask("task-1");

    resolveQuery?.();
    await nextPromise;
    let done = false;
    while (!done) {
      const result = await iterator.next();
      done = result.done ?? false;
    }
  });
});

// ---------------------------------------------------------------------------
// Streaming integration (stream_event messages)
// ---------------------------------------------------------------------------

describe("streaming integration", () => {
  test("stream_event messages produce granular events", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      // Streaming events
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
      },
      {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo!" } },
      },
      // Complete assistant message (should be suppressed)
      assistantMessage([{ type: "text", text: "Hello!" }]),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Hi" }));

    const textDeltas = events.filter(
      (e): e is EngineEvent & { readonly kind: "text_delta" } => e.kind === "text_delta",
    );

    // Should get granular deltas from stream_event, not the complete assistant message
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]?.delta).toBe("Hel");
    expect(textDeltas[1]?.delta).toBe("lo!");
  });

  test("assistant messages pass through when no stream_event precedes them", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      assistantMessage([{ type: "text", text: "Direct response" }]),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Hi" }));

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas).toHaveLength(1);
  });

  test("stream_event tool_call_start events are emitted", async () => {
    const sdk = createMockSdk([
      initMessage("sess-1"),
      {
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "call-1", name: "search" },
        },
      },
      {
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"q":"test"}' },
        },
      },
      {
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      },
      // Complete assistant (suppressed)
      assistantMessage([{ type: "tool_use", id: "call-1", name: "search", input: { q: "test" } }]),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Search" }));

    const toolStarts = events.filter((e) => e.kind === "tool_call_start");
    expect(toolStarts).toHaveLength(1);

    const toolDeltas = events.filter((e) => e.kind === "tool_call_delta");
    expect(toolDeltas).toHaveLength(1);
  });
});

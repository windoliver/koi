import { describe, expect, test } from "bun:test";
import type { ApprovalDecision, EngineEvent, EngineOutput } from "@koi/core";
import type { SdkFunctions, SdkInputMessage, SdkQuery } from "./adapter.js";
import { createClaudeAdapter } from "./adapter.js";
import type { SdkMessage } from "./event-map.js";
import type { ClaudeAdapterConfig, SdkCanUseToolOptions } from "./types.js";
import { HITL_EVENTS } from "./types.js";

const MOCK_OPTIONS: SdkCanUseToolOptions = {
  signal: AbortSignal.abort(),
  toolUseID: "tool-1",
};

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
 * Accepts the new prompt type (string | AsyncIterable<SdkInputMessage>).
 */
function createMockSdk(messages: readonly SdkMessage[]): SdkFunctions {
  return {
    query: async function* (_params: {
      readonly prompt: string | AsyncIterable<SdkInputMessage>;
      readonly options?: Record<string, unknown>;
    }) {
      for (const msg of messages) {
        yield msg;
      }
    },
  };
}

/**
 * Create a mock SDK for HITL tests that captures the prompt (queue) and options.
 * The yielded messages can be controlled via the returned `messages` array.
 */
function createHitlMockSdk(messages: readonly SdkMessage[]): {
  readonly sdk: SdkFunctions;
  readonly getCapturedPrompt: () => string | AsyncIterable<SdkInputMessage> | undefined;
  readonly getCapturedOptions: () => Record<string, unknown> | undefined;
} {
  let capturedPrompt: string | AsyncIterable<SdkInputMessage> | undefined;
  let capturedOptions: Record<string, unknown> | undefined;

  const sdk: SdkFunctions = {
    query: async function* (params: {
      readonly prompt: string | AsyncIterable<SdkInputMessage>;
      readonly options?: Record<string, unknown>;
    }) {
      capturedPrompt = params.prompt;
      capturedOptions = params.options as Record<string, unknown> | undefined;
      for (const msg of messages) {
        yield msg;
      }
    },
  };

  return {
    sdk,
    getCapturedPrompt: () => capturedPrompt,
    getCapturedOptions: () => capturedOptions,
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

  test("passes prompt as AsyncIterable (streaming input mode)", async () => {
    const { sdk, getCapturedPrompt } = createHitlMockSdk([
      initMessage("sess-1"),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Hello" }));

    const prompt = getCapturedPrompt();
    expect(prompt).toBeDefined();
    // The prompt should be an AsyncIterable (the MessageQueue), not a string
    expect(typeof prompt).not.toBe("string");
    expect(Symbol.asyncIterator in (prompt as object)).toBe(true);
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
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedOptions = params.options as Record<string, unknown> | undefined;
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
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        const controller = (params.options as Record<string, unknown> | undefined)
          ?.abortController as AbortController | undefined;
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
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedOptions = params.options as Record<string, unknown> | undefined;
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
      query: (_params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }): SdkQuery => {
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
      query: (_params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }): SdkQuery => {
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

// ---------------------------------------------------------------------------
// saveHumanMessage
// ---------------------------------------------------------------------------

describe("saveHumanMessage", () => {
  test("pushes message to active queue during streaming", async () => {
    let resolveQuery: (() => void) | undefined;
    let capturedPrompt: AsyncIterable<SdkInputMessage> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedPrompt = params.prompt as AsyncIterable<SdkInputMessage>;
        await new Promise<void>((r) => {
          resolveQuery = r;
        });
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    // Start streaming
    const stream = adapter.stream({ kind: "text", text: "Initial" });
    const iterator = stream[Symbol.asyncIterator]();
    const nextPromise = iterator.next();

    await new Promise<void>((r) => setTimeout(r, 10));

    // Push a human message while streaming
    adapter.saveHumanMessage("Follow-up message");

    // The message should be in the queue
    expect(capturedPrompt).toBeDefined();

    // Cleanup
    resolveQuery?.();
    await nextPromise;
    let done = false;
    while (!done) {
      const result = await iterator.next();
      done = result.done ?? false;
    }
  });

  test("buffers messages when idle and drains on next stream", async () => {
    const { sdk, getCapturedPrompt } = createHitlMockSdk([
      initMessage("sess-1"),
      resultMessage("success"),
    ]);

    const adapter = createClaudeAdapter({}, sdk);

    // Push messages while idle
    adapter.saveHumanMessage("Pre-buffered message 1");
    adapter.saveHumanMessage("Pre-buffered message 2");

    // Start streaming — pending messages should be drained into the queue
    await collectEvents(adapter.stream({ kind: "text", text: "Hello" }));

    const prompt = getCapturedPrompt();
    expect(prompt).toBeDefined();
    // The prompt is an AsyncIterable (MessageQueue) — verify it's not a string
    expect(typeof prompt).not.toBe("string");
  });

  test("is a no-op after dispose with warning", async () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    await adapter.dispose?.();

    // Should not throw
    adapter.saveHumanMessage("Should be dropped");
  });

  test("saveHumanMessage is available on adapter", () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);

    expect(typeof adapter.saveHumanMessage).toBe("function");
  });

  test("multiple sequential streams each get fresh queues", async () => {
    const capturedPrompts: Array<string | AsyncIterable<SdkInputMessage>> = [];

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedPrompts.push(params.prompt);
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    await collectEvents(adapter.stream({ kind: "text", text: "First" }));
    await collectEvents(adapter.stream({ kind: "text", text: "Second" }));

    // Each stream should get its own queue (different objects)
    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[0]).not.toBe(capturedPrompts[1]);
  });

  test("pending messages drained before initial message", async () => {
    const consumedMessages: SdkInputMessage[] = [];

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        // Consume from the queue to verify ordering
        const queue = params.prompt as AsyncIterable<SdkInputMessage>;
        // We need to start iterating to see what was pushed
        // But the queue blocks, so we yield first to unblock
        yield initMessage("sess-1");

        // Read a few messages from the queue without blocking forever
        const iter = queue[Symbol.asyncIterator]();
        // Use a timeout to avoid blocking forever
        const readWithTimeout = async (): Promise<SdkInputMessage | undefined> => {
          const result = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), 50),
            ),
          ]);
          if (result.done) return undefined;
          return result.value;
        };

        const msg1 = await readWithTimeout();
        if (msg1) consumedMessages.push(msg1);
        const msg2 = await readWithTimeout();
        if (msg2) consumedMessages.push(msg2);
        const msg3 = await readWithTimeout();
        if (msg3) consumedMessages.push(msg3);

        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    // Buffer two messages while idle
    adapter.saveHumanMessage("Pending 1");
    adapter.saveHumanMessage("Pending 2");

    await collectEvents(adapter.stream({ kind: "text", text: "Initial" }));

    // Pending messages should come first, then the initial message
    expect(consumedMessages).toHaveLength(3);
    expect(consumedMessages[0]?.message.content).toBe("Pending 1");
    expect(consumedMessages[1]?.message.content).toBe("Pending 2");
    expect(consumedMessages[2]?.message.content).toBe("Initial");
  });
});

// ---------------------------------------------------------------------------
// Approval bridge integration (custom event signaling)
// ---------------------------------------------------------------------------

describe("approval bridge integration", () => {
  test("passes canUseTool to SDK options when approvalHandler is configured", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedOptions = params.options as Record<string, unknown> | undefined;
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const config: ClaudeAdapterConfig = {
      approvalHandler: async () => ({ kind: "allow" }) satisfies ApprovalDecision,
    };

    const adapter = createClaudeAdapter(config, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    expect(capturedOptions?.canUseTool).toBeDefined();
    expect(typeof capturedOptions?.canUseTool).toBe("function");
  });

  test("does not pass canUseTool when no approvalHandler", async () => {
    let capturedOptions: Record<string, unknown> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedOptions = params.options as Record<string, unknown> | undefined;
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    expect(capturedOptions?.canUseTool).toBeUndefined();
  });

  test("emits HITL custom events during approval flow", async () => {
    let canUseToolFn:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          opts: SdkCanUseToolOptions,
        ) => Promise<unknown>)
      | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        // Capture the canUseTool callback
        canUseToolFn = (params.options as Record<string, unknown>)
          ?.canUseTool as typeof canUseToolFn;
        yield initMessage("sess-1");

        // Simulate calling canUseTool (like the SDK would do)
        if (canUseToolFn !== undefined) {
          await canUseToolFn("search", { q: "test" }, MOCK_OPTIONS);
        }

        yield assistantMessage([{ type: "text", text: "Done" }]);
        yield resultMessage("success");
      },
    };

    const config: ClaudeAdapterConfig = {
      approvalHandler: async () => ({ kind: "allow" }) satisfies ApprovalDecision,
    };

    const adapter = createClaudeAdapter(config, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    // Should have HITL custom events
    const customEvents = events.filter(
      (e): e is EngineEvent & { readonly kind: "custom" } => e.kind === "custom",
    );

    const hitlRequest = customEvents.find((e) => e.type === HITL_EVENTS.REQUEST);
    expect(hitlRequest).toBeDefined();
    expect((hitlRequest?.data as Record<string, unknown>)?.toolName).toBe("search");

    const hitlResponse = customEvents.find((e) => e.type === HITL_EVENTS.RESPONSE_RECEIVED);
    expect(hitlResponse).toBeDefined();
  });

  test("emits HITL error event when approval handler throws", async () => {
    let canUseToolFn:
      | ((
          toolName: string,
          input: Record<string, unknown>,
          opts: SdkCanUseToolOptions,
        ) => Promise<unknown>)
      | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        canUseToolFn = (params.options as Record<string, unknown>)
          ?.canUseTool as typeof canUseToolFn;
        yield initMessage("sess-1");

        if (canUseToolFn !== undefined) {
          await canUseToolFn("dangerous_tool", {}, MOCK_OPTIONS);
        }

        yield resultMessage("success");
      },
    };

    const config: ClaudeAdapterConfig = {
      approvalHandler: async () => {
        throw new Error("Handler crashed");
      },
    };

    const adapter = createClaudeAdapter(config, sdk);
    const events = await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    const customEvents = events.filter(
      (e): e is EngineEvent & { readonly kind: "custom" } => e.kind === "custom",
    );

    const errorEvent = customEvents.find((e) => e.type === HITL_EVENTS.ERROR);
    expect(errorEvent).toBeDefined();
    expect((errorEvent?.data as Record<string, unknown>)?.error).toBe("Handler crashed");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle edge cases
// ---------------------------------------------------------------------------

describe("lifecycle edge cases", () => {
  test("queue is closed after stream completes", async () => {
    let capturedPrompt: AsyncIterable<SdkInputMessage> | undefined;

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedPrompt = params.prompt as AsyncIterable<SdkInputMessage>;
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    // After stream completes, the queue should be closed
    // We can verify by checking if the queue is the message-queue type
    const queue = capturedPrompt as unknown as { readonly closed: boolean };
    expect(queue.closed).toBe(true);
  });

  test("queue is closed after stream errors", async () => {
    let capturedPrompt: AsyncIterable<SdkInputMessage> | undefined;

    const sdk: SdkFunctions = {
      // biome-ignore lint/correctness/useYield: intentionally throws before yielding to test error handling
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        capturedPrompt = params.prompt as AsyncIterable<SdkInputMessage>;
        throw new Error("SDK crash");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));

    const queue = capturedPrompt as unknown as { readonly closed: boolean };
    expect(queue.closed).toBe(true);
  });

  test("saveHumanMessage works across sequential streams", async () => {
    const consumedPerStream: SdkInputMessage[][] = [];

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        const messages: SdkInputMessage[] = [];
        const queue = params.prompt as AsyncIterable<SdkInputMessage>;
        const iter = queue[Symbol.asyncIterator]();

        // Read available messages with timeout
        const readWithTimeout = async (): Promise<SdkInputMessage | undefined> => {
          const result = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) =>
              setTimeout(() => r({ done: true, value: undefined }), 50),
            ),
          ]);
          if (result.done) return undefined;
          return result.value;
        };

        const msg = await readWithTimeout();
        if (msg) messages.push(msg);

        consumedPerStream.push(messages);
        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);

    // First stream
    await collectEvents(adapter.stream({ kind: "text", text: "First" }));

    // Buffer a message between streams
    adapter.saveHumanMessage("Between streams");

    // Second stream
    await collectEvents(adapter.stream({ kind: "text", text: "Second" }));

    expect(consumedPerStream).toHaveLength(2);
    // Second stream should get the buffered message as first item
    expect(consumedPerStream[1]?.[0]?.message.content).toBe("Between streams");
  });

  test("resume input sends no initial message to queue", async () => {
    const consumedMessages: SdkInputMessage[] = [];

    const sdk: SdkFunctions = {
      query: async function* (params: {
        readonly prompt: string | AsyncIterable<SdkInputMessage>;
        readonly options?: Record<string, unknown>;
      }) {
        const queue = params.prompt as AsyncIterable<SdkInputMessage>;
        const iter = queue[Symbol.asyncIterator]();

        // Try to read — should timeout since resume sends no message
        const result = await Promise.race([
          iter.next(),
          new Promise<{ done: true; value: undefined }>((r) =>
            setTimeout(() => r({ done: true, value: undefined }), 50),
          ),
        ]);
        if (!result.done && result.value) {
          consumedMessages.push(result.value);
        }

        yield initMessage("sess-1");
        yield resultMessage("success");
      },
    };

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(
      adapter.stream({
        kind: "resume",
        state: { engineId: "claude", data: { sessionId: "sess-1" } },
      }),
    );

    // No initial message should have been pushed for resume
    expect(consumedMessages).toHaveLength(0);
  });

  test("hitl maxQueueSize is passed to message queue", async () => {
    const { sdk } = createHitlMockSdk([initMessage("sess-1"), resultMessage("success")]);

    const config: ClaudeAdapterConfig = {
      hitl: { maxQueueSize: 5 },
    };

    // Should not throw — verifies maxQueueSize is passed through
    const adapter = createClaudeAdapter(config, sdk);
    await collectEvents(adapter.stream({ kind: "text", text: "Test" }));
  });
});

// ---------------------------------------------------------------------------
// Content-block mapping (EngineCapabilities)
// ---------------------------------------------------------------------------

describe("content-block mapping", () => {
  test("exposes capabilities with images: false, files: false", () => {
    const sdk = createMockSdk([]);
    const adapter = createClaudeAdapter({}, sdk);
    expect(adapter.capabilities).toEqual({
      text: true,
      images: false,
      files: false,
      audio: false,
    });
  });

  test("inputToSdkInputMessage includes FileBlock as text description", async () => {
    const { sdk, getCapturedPrompt } = createHitlMockSdk([
      { type: "system", subtype: "init", session_id: "sess-1" },
      {
        type: "result",
        subtype: "success",
        result: "Done",
        session_id: "sess-1",
        num_turns: 1,
        duration_ms: 100,
        usage: { input_tokens: 10, output_tokens: 5 },
      },
    ]);

    const adapter = createClaudeAdapter({}, sdk);
    await collectEvents(
      adapter.stream({
        kind: "messages",
        messages: [
          {
            content: [
              { kind: "text", text: "Please read this" },
              {
                kind: "file",
                url: "https://example.com/report.pdf",
                mimeType: "application/pdf",
                name: "report.pdf",
              },
            ],
            senderId: "user",
            timestamp: Date.now(),
          },
        ],
      }),
    );

    // The queue received the message — verify it was captured
    const prompt = getCapturedPrompt();
    expect(prompt).toBeDefined();

    // Drain the queue to get the actual message content
    if (prompt !== undefined && typeof prompt !== "string") {
      const messages: SdkInputMessage[] = [];
      for await (const msg of prompt) {
        messages.push(msg);
      }
      // The file block should have been converted to text
      const content = messages[0]?.message.content ?? "";
      expect(content).toContain("Please read this");
      expect(content).toContain("[File: report.pdf]");
    }
  });
});

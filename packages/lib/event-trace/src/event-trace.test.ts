import { describe, expect, test } from "bun:test";
import type {
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ToolRequest,
  ToolResponse,
} from "@koi/core/middleware";
import type { RichTrajectoryStep, TrajectoryDocumentStore } from "@koi/core/rich-trajectory";
import { createInMemoryAtifDocumentStore } from "./atif-store.js";
import { createEventTraceMiddleware } from "./event-trace.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockStore(): TrajectoryDocumentStore & { readonly steps: RichTrajectoryStep[][] } {
  const steps: RichTrajectoryStep[][] = [];
  return {
    steps,
    async append(_docId: string, newSteps: readonly RichTrajectoryStep[]): Promise<void> {
      steps.push([...newSteps]);
    },
    async getDocument(): Promise<readonly RichTrajectoryStep[]> {
      return steps.flat();
    },
    async getStepRange(): Promise<readonly RichTrajectoryStep[]> {
      return [];
    },
    async getSize(): Promise<number> {
      return 0;
    },
    async prune(): Promise<number> {
      return 0;
    },
  };
}

function makeSessionCtx(sessionId = "test-session") {
  return {
    agentId: "agent-1",
    sessionId: sessionId as unknown as import("@koi/core/ecs").SessionId,
    runId: "run-1" as unknown as import("@koi/core/ecs").RunId,
    metadata: {},
  };
}

function makeTurnCtx(turnIndex = 0, sessionId = "test-session") {
  return {
    session: makeSessionCtx(sessionId),
    turnIndex,
    turnId: `turn-${String(turnIndex)}` as unknown as import("@koi/core/ecs").TurnId,
    messages: [],
    metadata: {},
  };
}

function makeModelRequest(text = "Hello"): ModelRequest {
  return {
    messages: [
      {
        content: [{ kind: "text" as const, text }],
        senderId: "user",
        timestamp: Date.now(),
      },
    ],
    model: "test-model",
  };
}

function makeModelResponse(content = "Hi there!"): ModelResponse {
  return {
    content,
    model: "test-model",
    usage: { inputTokens: 100, outputTokens: 50 },
  };
}

function makeToolRequest(toolId = "web_search"): ToolRequest {
  return {
    toolId,
    input: { query: "test" },
  };
}

function makeToolResponse(output: unknown = "results"): ToolResponse {
  return { output };
}

// ---------------------------------------------------------------------------
// Basic middleware behavior
// ---------------------------------------------------------------------------

describe("createEventTraceMiddleware", () => {
  test("returns middleware with correct name and phase", () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    expect(middleware.name).toBe("event-trace");
    expect(middleware.priority).toBe(100);
    expect(middleware.phase).toBe("observe");
  });

  test("getTrajectoryStore returns the backing store", () => {
    const store = makeMockStore();
    const { getTrajectoryStore } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    expect(getTrajectoryStore()).toBe(store);
  });
});

describe("wrapModelCall", () => {
  test("records model call with request and response", async () => {
    // let: mutable clock for deterministic timing
    let time = 1000;
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => time,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const response = makeModelResponse();
    const result = await middleware.wrapModelCall?.(
      makeTurnCtx(0),
      makeModelRequest(),
      async () => {
        time += 1500;
        return response;
      },
    );

    expect(result).toBe(response);

    // Flush on turn end
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    expect(store.steps).toHaveLength(1);
    const step = store.steps[0]?.[0];
    expect(step?.source).toBe("agent");
    expect(step?.kind).toBe("model_call");
    expect(step?.durationMs).toBe(1500);
    expect(step?.outcome).toBe("success");
    expect(step?.identifier).toBe("test-model");
  });

  test("records failure when model call throws", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => 1000,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    try {
      await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () => {
        throw new Error("model failed");
      });
    } catch {
      // Expected
    }

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.outcome).toBe("failure");
  });
});

describe("wrapToolCall", () => {
  test("records tool call with truncated output", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => 1000,
      maxOutputBytes: 50,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const longOutput = "x".repeat(100);
    await middleware.wrapToolCall?.(makeTurnCtx(0), makeToolRequest(), async () =>
      makeToolResponse(longOutput),
    );

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.source).toBe("tool");
    expect(step?.kind).toBe("tool_call");
    expect(step?.identifier).toBe("web_search");
    expect(step?.response?.truncated).toBe(true);
  });

  test("passes through response from next handler", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    const expected = makeToolResponse("data");
    const result = await middleware.wrapToolCall?.(
      makeTurnCtx(0),
      makeToolRequest(),
      async () => expected,
    );

    expect(result).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

describe("wrapModelStream", () => {
  test("happy path: records response from done chunk", async () => {
    // let: mutable clock for deterministic timing
    let time = 1000;
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => time,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const response = makeModelResponse("streamed content");
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "streamed " },
      { kind: "text_delta", delta: "content" },
      { kind: "done", response },
    ];

    async function* mockStream(): AsyncIterable<ModelChunk> {
      for (const chunk of chunks) {
        time += 100;
        yield chunk;
      }
    }

    const collected: ModelChunk[] = [];
    const stream = middleware.wrapModelStream?.(makeTurnCtx(0), makeModelRequest(), () =>
      mockStream(),
    );
    for await (const chunk of stream ?? []) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(3);

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.kind).toBe("model_call");
    expect(step?.outcome).toBe("success");
    expect(step?.response?.text).toBe("streamed content");
    expect(step?.durationMs).toBe(300);
  });

  test("accumulates text_delta when done chunk has empty content", async () => {
    let time = 1000;
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => time,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    // Real streaming: done chunk has empty content, text arrives via deltas
    const response = makeModelResponse("");
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "The answer " },
      { kind: "text_delta", delta: "is 12." },
      { kind: "done", response },
    ];

    async function* mockStream(): AsyncIterable<ModelChunk> {
      for (const chunk of chunks) {
        time += 100;
        yield chunk;
      }
    }

    const collected: ModelChunk[] = [];
    const stream = middleware.wrapModelStream?.(makeTurnCtx(0), makeModelRequest(), () =>
      mockStream(),
    );
    for await (const chunk of stream ?? []) {
      collected.push(chunk);
    }

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.kind).toBe("model_call");
    expect(step?.response?.text).toBe("The answer is 12.");
  });

  test("error path: records failure when stream throws mid-iteration", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => 1000,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    async function* failingStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "partial" };
      throw new Error("stream failed");
    }

    try {
      const failStream = middleware.wrapModelStream?.(makeTurnCtx(0), makeModelRequest(), () =>
        failingStream(),
      );
      for await (const _chunk of failStream ?? []) {
        // Consume chunks
      }
    } catch {
      // Expected
    }

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.outcome).toBe("failure");
    expect(step?.response).toBeUndefined();
  });

  test("empty stream: records step with no response", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => 1000,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    async function* emptyStream(): AsyncIterable<ModelChunk> {
      // Yields nothing
    }

    const collected: ModelChunk[] = [];
    const emptyStreamResult = middleware.wrapModelStream?.(makeTurnCtx(0), makeModelRequest(), () =>
      emptyStream(),
    );
    for await (const chunk of emptyStreamResult ?? []) {
      collected.push(chunk);
    }

    expect(collected).toHaveLength(0);

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.outcome).toBe("failure");
  });
});

// ---------------------------------------------------------------------------
// Turn-based flush
// ---------------------------------------------------------------------------

describe("turn-based flush", () => {
  test("steps are persisted immediately on capture (not deferred to onAfterTurn)", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );

    // Immediately persisted — no need to wait for onAfterTurn
    expect(store.steps).toHaveLength(1);
  });

  test("empty turn does not flush", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    expect(store.steps).toHaveLength(0);
  });

  test("onSessionEnd flushes remaining steps", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );

    // Skip onAfterTurn, go straight to session end
    await middleware.onSessionEnd?.(makeSessionCtx());

    expect(store.steps).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Monotonic step indices
// ---------------------------------------------------------------------------

describe("step index monotonicity", () => {
  test("step indices are monotonically increasing across turns (real store)", async () => {
    // Use real store — it assigns document-global IDs atomically during append
    const realStore = createInMemoryAtifDocumentStore({ agentName: "test" });
    const { middleware } = createEventTraceMiddleware({
      store: realStore,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());

    // Turn 0: 2 events
    await middleware.onBeforeTurn?.(makeTurnCtx(0));
    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    await middleware.wrapToolCall?.(makeTurnCtx(0), makeToolRequest(), async () =>
      makeToolResponse(),
    );
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    // Turn 1: 1 event
    await middleware.onBeforeTurn?.(makeTurnCtx(1));
    await middleware.wrapModelCall?.(makeTurnCtx(1), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    await middleware.onAfterTurn?.(makeTurnCtx(1));

    // onSessionEnd awaits all in-flight writes
    await middleware.onSessionEnd?.(makeSessionCtx());

    const allSteps = await realStore.getDocument("doc-1");
    expect(allSteps).toHaveLength(3);
    expect(allSteps[0]?.stepIndex).toBe(0);
    expect(allSteps[1]?.stepIndex).toBe(1);
    expect(allSteps[2]?.stepIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Concurrent tool calls
// ---------------------------------------------------------------------------

describe("concurrent tool calls", () => {
  test("overlapping async tool calls get unique monotonic indices", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    // Start two tool calls concurrently
    const toolA = middleware.wrapToolCall?.(makeTurnCtx(0), makeToolRequest("tool_a"), async () => {
      // Simulate tool A taking longer
      await new Promise((resolve) => setTimeout(resolve, 50));
      return makeToolResponse("result_a");
    });

    const toolB = middleware.wrapToolCall?.(makeTurnCtx(0), makeToolRequest("tool_b"), async () => {
      // Tool B completes first
      await new Promise((resolve) => setTimeout(resolve, 10));
      return makeToolResponse("result_b");
    });

    await Promise.all([toolA, toolB]);

    // With immediate recording, each tool writes its own append()
    const allSteps = store.steps.flat();
    expect(allSteps).toHaveLength(2);

    // Both should have unique indices
    const indices = allSteps.map((s) => s.stepIndex);
    expect(new Set(indices).size).toBe(2);

    // Both results should be recorded
    const identifiers = allSteps.map((s) => s.identifier);
    expect(identifiers).toContain("tool_a");
    expect(identifiers).toContain("tool_b");
  });
});

// ---------------------------------------------------------------------------
// Error resilience (degraded mode)
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  test("middleware continues when store.append throws on onAfterTurn", async () => {
    const failingStore: TrajectoryDocumentStore = {
      async append(): Promise<void> {
        throw new Error("store failure");
      },
      async getDocument(): Promise<readonly RichTrajectoryStep[]> {
        return [];
      },
      async getStepRange(): Promise<readonly RichTrajectoryStep[]> {
        return [];
      },
      async getSize(): Promise<number> {
        return 0;
      },
      async prune(): Promise<number> {
        return 0;
      },
    };

    const { middleware } = createEventTraceMiddleware({
      store: failingStore,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    // Model call should still work normally
    const response = makeModelResponse();
    const result = await middleware.wrapModelCall?.(
      makeTurnCtx(0),
      makeModelRequest(),
      async () => response,
    );
    expect(result).toBe(response);

    // onAfterTurn should not throw (degraded mode)
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    // Next turn should still work
    await middleware.onBeforeTurn?.(makeTurnCtx(1));
    const result2 = await middleware.wrapModelCall?.(
      makeTurnCtx(1),
      makeModelRequest(),
      async () => response,
    );
    expect(result2).toBe(response);
    await middleware.onAfterTurn?.(makeTurnCtx(1));
  });

  test("onSessionEnd handles store failure gracefully", async () => {
    const failingStore: TrajectoryDocumentStore = {
      async append(): Promise<void> {
        throw new Error("store failure");
      },
      async getDocument(): Promise<readonly RichTrajectoryStep[]> {
        return [];
      },
      async getStepRange(): Promise<readonly RichTrajectoryStep[]> {
        return [];
      },
      async getSize(): Promise<number> {
        return 0;
      },
      async prune(): Promise<number> {
        return 0;
      },
    };

    const { middleware } = createEventTraceMiddleware({
      store: failingStore,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );

    // Should not throw
    await middleware.onSessionEnd?.(makeSessionCtx());
  });

  test("wrapModelCall passes through when no session state", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    // Don't call onSessionStart
    const response = makeModelResponse();
    const result = await middleware.wrapModelCall?.(
      makeTurnCtx(0),
      makeModelRequest(),
      async () => response,
    );
    expect(result).toBe(response);
  });
});

// ---------------------------------------------------------------------------
// Session isolation
// ---------------------------------------------------------------------------

describe("session isolation", () => {
  test("sequential sessions continue step IDs from the same document", async () => {
    // Use real store so getDocument returns persisted steps
    const realStore = createInMemoryAtifDocumentStore({ agentName: "test" });
    const { middleware } = createEventTraceMiddleware({
      store: realStore,
      docId: "doc-1",
      agentName: "test",
    });

    // Session A: writes steps 0, 1
    await middleware.onSessionStart?.(makeSessionCtx("session-a"));
    await middleware.onBeforeTurn?.(makeTurnCtx(0, "session-a"));
    await middleware.wrapModelCall?.(makeTurnCtx(0, "session-a"), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    await middleware.wrapToolCall?.(makeTurnCtx(0, "session-a"), makeToolRequest(), async () =>
      makeToolResponse(),
    );
    await middleware.onAfterTurn?.(makeTurnCtx(0, "session-a"));
    await middleware.onSessionEnd?.(makeSessionCtx("session-a"));

    // Session B: should continue from step 2 (not 0)
    await middleware.onSessionStart?.(makeSessionCtx("session-b"));
    await middleware.onBeforeTurn?.(makeTurnCtx(0, "session-b"));
    await middleware.wrapModelCall?.(makeTurnCtx(0, "session-b"), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    await middleware.onAfterTurn?.(makeTurnCtx(0, "session-b"));
    await middleware.onSessionEnd?.(makeSessionCtx("session-b"));

    const allSteps = await realStore.getDocument("doc-1");
    expect(allSteps).toHaveLength(3);
    // No duplicate step IDs
    expect(allSteps[0]?.stepIndex).toBe(0);
    expect(allSteps[1]?.stepIndex).toBe(1);
    expect(allSteps[2]?.stepIndex).toBe(2);
  });

  test("onSessionEnd cleans up session state", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onSessionEnd?.(makeSessionCtx());

    // describeCapabilities should return undefined for cleaned-up session
    const caps = middleware.describeCapabilities(makeTurnCtx(0));
    expect(caps).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// describeCapabilities
// ---------------------------------------------------------------------------

describe("describeCapabilities", () => {
  test("returns event count for active session", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );

    const caps = middleware.describeCapabilities(makeTurnCtx(0));
    expect(caps?.label).toBe("tracing");
    // With immediate recording, retryQueue is 0 after successful write
    expect(caps?.description).toContain("0");
  });
});

// ---------------------------------------------------------------------------
// Error capture
// ---------------------------------------------------------------------------

describe("error capture", () => {
  test("wrapModelCall captures error content on failure", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => 1000,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    try {
      await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () => {
        throw new Error("model timeout");
      });
    } catch {
      // Expected
    }

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.outcome).toBe("failure");
    expect(step?.error?.text).toBe("model timeout");
    expect((step?.error?.data as Record<string, unknown>)?.errorType).toBe("Error");
  });

  test("wrapToolCall captures error content on failure", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => 1000,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    try {
      await middleware.wrapToolCall?.(makeTurnCtx(0), makeToolRequest(), async () => {
        throw new Error("tool crashed");
      });
    } catch {
      // Expected
    }

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.error?.text).toBe("tool crashed");
  });

  test("captures error cause chain", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
      clock: () => 1000,
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    try {
      await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () => {
        throw new Error("request failed", { cause: "network timeout" });
      });
    } catch {
      // Expected
    }

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.error?.text).toBe("request failed");
    expect((step?.error?.data as Record<string, unknown>)?.cause).toBe("network timeout");
  });
});

// ---------------------------------------------------------------------------
// Model request metadata capture
// ---------------------------------------------------------------------------

describe("model request metadata", () => {
  test("captures temperature, maxTokens, and model name", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "Hi" }],
          senderId: "user",
          timestamp: Date.now(),
        },
      ],
      model: "claude-sonnet-4-20250514",
      temperature: 0.7,
      maxTokens: 4096,
    };

    await middleware.wrapModelCall?.(makeTurnCtx(0), request, async () => makeModelResponse());
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const meta = store.steps[0]?.[0]?.metadata as Record<string, unknown>;
    expect(meta?.requestModel).toBe("claude-sonnet-4-20250514");
    expect(meta?.temperature).toBe(0.7);
    expect(meta?.maxTokens).toBe(4096);
  });

  test("captures tool definitions sent to model", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "Search for cats" }],
          senderId: "user",
          timestamp: Date.now(),
        },
      ],
      model: "test-model",
      tools: [
        { name: "web_search", description: "Search the web", inputSchema: {} },
        { name: "file_read", description: "Read a file", inputSchema: {} },
      ],
    };

    await middleware.wrapModelCall?.(makeTurnCtx(0), request, async () => makeModelResponse());
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const meta = store.steps[0]?.[0]?.metadata as Record<string, unknown>;
    expect(meta?.toolCount).toBe(2);
    const tools = meta?.tools as readonly { name: string; description: string }[];
    expect(tools?.[0]?.name).toBe("web_search");
    expect(tools?.[1]?.name).toBe("file_read");
  });
});

// ---------------------------------------------------------------------------
// Sender filtering in extractLastUserMessage
// ---------------------------------------------------------------------------

describe("extractLastUserMessage sender filtering", () => {
  test("skips assistant messages and finds user message", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "What is 2+2?" }],
          senderId: "user",
          timestamp: 1000,
        },
        {
          content: [{ kind: "text" as const, text: "The answer is 4." }],
          senderId: "assistant",
          timestamp: 2000,
        },
        {
          content: [{ kind: "text" as const, text: "Thanks!" }],
          senderId: "user",
          timestamp: 3000,
        },
      ],
      model: "test-model",
    };

    await middleware.wrapModelCall?.(makeTurnCtx(0), request, async () => makeModelResponse());
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    // Should capture the LAST user message, skipping the assistant message
    const step = store.steps[0]?.[0];
    expect(step?.request?.text).toBe("Thanks!");
  });

  test("skips system messages", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "You are helpful." }],
          senderId: "system",
          timestamp: 1000,
        },
        {
          content: [{ kind: "text" as const, text: "Hello" }],
          senderId: "user",
          timestamp: 2000,
        },
      ],
      model: "test-model",
    };

    await middleware.wrapModelCall?.(makeTurnCtx(0), request, async () => makeModelResponse());
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.request?.text).toBe("Hello");
  });
});

// ---------------------------------------------------------------------------
// System prompt capture
// ---------------------------------------------------------------------------

describe("system prompt capture", () => {
  test("captures system prompt in metadata", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const request: ModelRequest = {
      messages: [
        {
          content: [{ kind: "text" as const, text: "You are a helpful coding assistant." }],
          senderId: "system",
          timestamp: 1000,
        },
        {
          content: [{ kind: "text" as const, text: "Write a function" }],
          senderId: "user",
          timestamp: 2000,
        },
      ],
      model: "test-model",
    };

    await middleware.wrapModelCall?.(makeTurnCtx(0), request, async () => makeModelResponse());
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const meta = store.steps[0]?.[0]?.metadata as Record<string, unknown>;
    expect(meta?.systemPrompt).toBe("You are a helpful coding assistant.");
  });

  test("omits systemPrompt when no system message present", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const meta = store.steps[0]?.[0]?.metadata as Record<string, unknown>;
    expect(meta?.systemPrompt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Response metadata (finish reason, response model)
// ---------------------------------------------------------------------------

describe("response metadata capture", () => {
  test("captures response model and metadata from ModelResponse", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const response: ModelResponse = {
      content: "Hello!",
      model: "claude-sonnet-4-20250514",
      usage: { inputTokens: 100, outputTokens: 50 },
      metadata: { finish_reason: "stop", response_id: "resp_123" },
    };

    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () => response);
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const meta = store.steps[0]?.[0]?.metadata as Record<string, unknown>;
    expect(meta?.responseModel).toBe("claude-sonnet-4-20250514");
    expect(meta?.finish_reason).toBe("stop");
    expect(meta?.response_id).toBe("resp_123");
  });
});

// ---------------------------------------------------------------------------
// Reasoning/thinking content from stream
// ---------------------------------------------------------------------------

describe("reasoning content capture", () => {
  test("accumulates thinking_delta chunks into reasoningContent", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const response = makeModelResponse("Final answer");
    const chunks: ModelChunk[] = [
      { kind: "thinking_delta", delta: "Let me think " },
      { kind: "thinking_delta", delta: "about this..." },
      { kind: "text_delta", delta: "Final answer" },
      { kind: "done", response },
    ];

    async function* mockStream(): AsyncIterable<ModelChunk> {
      for (const chunk of chunks) yield chunk;
    }

    const stream = middleware.wrapModelStream?.(makeTurnCtx(0), makeModelRequest(), () =>
      mockStream(),
    );
    for await (const _chunk of stream ?? []) {
      // consume
    }
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.reasoningContent).toBe("Let me think about this...");
  });

  test("no reasoningContent when no thinking chunks", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const response = makeModelResponse("Answer");
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "Answer" },
      { kind: "done", response },
    ];

    async function* mockStream(): AsyncIterable<ModelChunk> {
      for (const chunk of chunks) yield chunk;
    }

    const stream = middleware.wrapModelStream?.(makeTurnCtx(0), makeModelRequest(), () =>
      mockStream(),
    );
    for await (const _chunk of stream ?? []) {
      // consume
    }
    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.reasoningContent).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Safe serialization (circular/BigInt tool output must not crash)
// ---------------------------------------------------------------------------

describe("safe tool output serialization", () => {
  test("circular object does not throw — falls back to placeholder", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    // Create circular reference
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;

    // This must NOT throw — observer contract
    const response = await middleware.wrapToolCall?.(makeTurnCtx(0), makeToolRequest(), async () =>
      makeToolResponse(circular),
    );
    expect(response).toBeDefined();

    await middleware.onAfterTurn?.(makeTurnCtx(0));

    const step = store.steps[0]?.[0];
    expect(step?.response?.text).toContain("unserializable");
  });

  test("BigInt output does not throw", async () => {
    const store = makeMockStore();
    const { middleware } = createEventTraceMiddleware({
      store,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());
    await middleware.onBeforeTurn?.(makeTurnCtx(0));

    const response = await middleware.wrapToolCall?.(makeTurnCtx(0), makeToolRequest(), async () =>
      makeToolResponse(BigInt(9007199254740991)),
    );
    expect(response).toBeDefined();

    await middleware.onAfterTurn?.(makeTurnCtx(0));
    const step = store.steps[0]?.[0];
    expect(step?.response?.text).toContain("unserializable");
  });
});

// ---------------------------------------------------------------------------
// Transient flush failure retry
// ---------------------------------------------------------------------------

describe("flush retry on transient failure", () => {
  test("retains step after first failure, retries on next recordStep", async () => {
    // let: mutable counter tracking append calls
    let appendCallCount = 0;
    const failOnceStore: TrajectoryDocumentStore = {
      async append(): Promise<void> {
        appendCallCount += 1;
        if (appendCallCount === 1) throw new Error("transient failure");
        // Subsequent calls succeed
      },
      async getDocument(): Promise<readonly RichTrajectoryStep[]> {
        return [];
      },
      async getStepRange(): Promise<readonly RichTrajectoryStep[]> {
        return [];
      },
      async getSize(): Promise<number> {
        return 0;
      },
      async prune(): Promise<number> {
        return 0;
      },
    };

    const { middleware } = createEventTraceMiddleware({
      store: failOnceStore,
      docId: "doc-1",
      agentName: "test",
    });

    await middleware.onSessionStart?.(makeSessionCtx());

    // First model call — immediate write fails, step queued for retry
    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    expect(appendCallCount).toBe(1); // One failed attempt

    // Second model call — drains retry queue (succeeds), then writes fresh step (succeeds)
    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    // append #2: retry queue drain, append #3: fresh step
    expect(appendCallCount).toBe(3);
  });

  test("drops stale retries but preserves fresh step's retry budget", async () => {
    const alwaysFailStore: TrajectoryDocumentStore = {
      async append(): Promise<void> {
        throw new Error("persistent failure");
      },
      async getDocument(): Promise<readonly RichTrajectoryStep[]> {
        return [];
      },
      async getStepRange(): Promise<readonly RichTrajectoryStep[]> {
        return [];
      },
      async getSize(): Promise<number> {
        return 0;
      },
      async prune(): Promise<number> {
        return 0;
      },
    };

    // let: tracks total trace loss
    let totalLost = 0;
    const { middleware } = createEventTraceMiddleware({
      store: alwaysFailStore,
      docId: "doc-1",
      agentName: "test",
      onTraceLoss: (count) => {
        totalLost += count;
      },
    });

    await middleware.onSessionStart?.(makeSessionCtx());

    // Call 1: write fails → step queued for retry, no loss yet
    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    expect(totalLost).toBe(0);

    // Call 2: retry queue drain fails (stale step1 dropped), fresh step2 fails (queued)
    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    expect(totalLost).toBe(1); // Only stale step dropped

    // Call 3: retry queue drain fails (step2 dropped), fresh step3 fails (queued)
    await middleware.wrapModelCall?.(makeTurnCtx(0), makeModelRequest(), async () =>
      makeModelResponse(),
    );
    expect(totalLost).toBe(2); // One more stale step dropped
  });
});

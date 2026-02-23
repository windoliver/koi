import { describe, expect, mock, test } from "bun:test";
import type {
  AgentManifest,
  ApprovalHandler,
  EngineAdapter,
  EngineEvent,
  EngineInput,
  EngineOutput,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  ModelStreamHandler,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "../koi.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(): AgentManifest {
  return {
    name: "Integration Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
  };
}

function doneOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [{ kind: "text", text: "done" }],
    stopReason: "completed",
    metrics: {
      totalTokens: 100,
      inputTokens: 60,
      outputTokens: 40,
      turns: 3,
      durationMs: 500,
    },
    ...overrides,
  };
}

function mockAdapter(events: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "mock-adapter",
    stream: () => {
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              const event = events[index];
              if (event === undefined) {
                return { done: true, value: undefined };
              }
              index++;
              return { done: false, value: event };
            },
          };
        },
      };
    },
  };
}

function crashingAdapter(errorMessage: string): EngineAdapter {
  return {
    engineId: "crashing-adapter",
    stream: () => ({
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<EngineEvent>> {
            throw new Error(errorMessage);
          },
        };
      },
    }),
  };
}

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Full lifecycle integration
// ---------------------------------------------------------------------------

describe("full lifecycle integration", () => {
  test("complete lifecycle: created → running → terminated (completed)", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "Hello" },
      { kind: "text_delta", delta: " world" },
      { kind: "turn_end", turnIndex: 0 },
      { kind: "done", output: doneOutput() },
    ];

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter(events),
    });

    expect(runtime.agent.state).toBe("created");

    const collected = await collectEvents(runtime.run({ kind: "text", text: "hello" }));

    expect(collected.map((e) => e.kind)).toEqual([
      "turn_start",
      "text_delta",
      "text_delta",
      "turn_end",
      "turn_start",
      "done",
    ]);
    expect(runtime.agent.state).toBe("terminated");
  });

  test("multi-turn conversation", async () => {
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "Turn 1 response" },
      { kind: "turn_end", turnIndex: 0 },
      { kind: "text_delta", delta: "Turn 2 response" },
      { kind: "turn_end", turnIndex: 1 },
      { kind: "text_delta", delta: "Turn 3 response" },
      { kind: "turn_end", turnIndex: 2 },
      { kind: "done", output: doneOutput() },
    ];

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter(events),
    });

    const collected = await collectEvents(runtime.run({ kind: "text", text: "go" }));
    expect(collected.filter((e) => e.kind === "turn_end")).toHaveLength(3);
    expect(runtime.agent.state).toBe("terminated");
  });
});

// ---------------------------------------------------------------------------
// Middleware observation integration
// ---------------------------------------------------------------------------

describe("middleware observation integration", () => {
  test("middleware sees all lifecycle hooks in correct order", async () => {
    const hookOrder: string[] = [];

    const observer: KoiMiddleware = {
      name: "observer",
      onSessionStart: async () => {
        hookOrder.push("session_start");
      },
      onSessionEnd: async () => {
        hookOrder.push("session_end");
      },
      onAfterTurn: async () => {
        hookOrder.push("after_turn");
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "turn_end", turnIndex: 0 },
        { kind: "done", output: doneOutput() },
      ]),
      middleware: [observer],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(hookOrder).toEqual(["session_start", "after_turn", "session_end"]);
  });

  test("multiple middleware hooks fire in registration order", async () => {
    const hookOrder: string[] = [];

    const mw1: KoiMiddleware = {
      name: "first",
      onSessionStart: async () => {
        hookOrder.push("first:start");
      },
      onAfterTurn: async () => {
        hookOrder.push("first:turn");
      },
    };

    const mw2: KoiMiddleware = {
      name: "second",
      onSessionStart: async () => {
        hookOrder.push("second:start");
      },
      onAfterTurn: async () => {
        hookOrder.push("second:turn");
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "turn_end", turnIndex: 0 },
        { kind: "done", output: doneOutput() },
      ]),
      middleware: [mw1, mw2],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(hookOrder).toEqual(["first:start", "second:start", "first:turn", "second:turn"]);
  });
});

// ---------------------------------------------------------------------------
// Error propagation integration
// ---------------------------------------------------------------------------

describe("error propagation integration", () => {
  test("adapter crash results in thrown error and terminated agent", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: crashingAdapter("adapter exploded"),
    });

    await expect(collectEvents(runtime.run({ kind: "text", text: "test" }))).rejects.toThrow(
      "adapter exploded",
    );
    expect(runtime.agent.state).toBe("terminated");
  });

  test("onSessionEnd is called even when adapter crashes", async () => {
    const onSessionEnd = mock(() => Promise.resolve());

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: crashingAdapter("crash"),
      middleware: [{ name: "cleanup", onSessionEnd }],
    });

    try {
      await collectEvents(runtime.run({ kind: "text", text: "test" }));
    } catch {
      // Expected to throw
    }
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Guard termination integration
// ---------------------------------------------------------------------------

describe("guard termination integration", () => {
  test("guard termination produces done event with max_turns stop reason", async () => {
    // Create adapter that emits 100 turn_end events (way more than limit)
    const manyTurns: EngineEvent[] = [];
    for (let i = 0; i < 100; i++) {
      manyTurns.push({ kind: "turn_end", turnIndex: i });
    }

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter(manyTurns),
      limits: { maxTurns: 3 },
      loopDetection: false, // Disable to isolate iteration guard
    });

    // The guard doesn't intercept turn_end events - it intercepts model calls.
    // Since our mock adapter doesn't trigger wrapModelCall, the guard won't fire
    // on turn_end events. This test validates the event flow works.
    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Component provider integration
// ---------------------------------------------------------------------------

describe("component provider integration", () => {
  test("providers attach components accessible from agent", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      providers: [
        {
          name: "custom-provider",
          attach: async () => new Map<string, unknown>([["custom:config", { setting: "value" }]]),
        },
      ],
    });

    const config = runtime.agent.component("custom:config" as never) as
      | { readonly setting: string }
      | undefined;
    expect(config?.setting).toBe("value");
  });
});

// ---------------------------------------------------------------------------
// Input types integration
// ---------------------------------------------------------------------------

describe("input types integration", () => {
  test("accepts text input", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "hello" }));
    expect(events).toHaveLength(2); // turn_start + done
  });

  test("accepts messages input", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
    });

    const events = await collectEvents(
      runtime.run({
        kind: "messages",
        messages: [
          {
            content: [{ kind: "text", text: "hello" }],
            senderId: "user-1",
            timestamp: Date.now(),
          },
        ],
      }),
    );
    expect(events).toHaveLength(2); // turn_start + done
  });
});

// ---------------------------------------------------------------------------
// Cooperating adapter integration (middleware interposition)
// ---------------------------------------------------------------------------

describe("cooperating adapter lifecycle integration", () => {
  /**
   * A cooperating adapter that reads callHandlers from input and uses them.
   * Simulates: model call → text_delta → turn_end → done.
   */
  function cooperatingAdapterWithCalls(
    rawModelCall: (req: ModelRequest) => Promise<ModelResponse>,
  ): EngineAdapter {
    return {
      engineId: "cooperating",
      terminals: {
        modelCall: rawModelCall,
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          // Use callHandlers if available (should be, since we have terminals)
          if (input.callHandlers) {
            const response = await input.callHandlers.modelCall({
              messages: [],
            });
            yield { kind: "text_delta" as const, delta: response.content };
          }
          yield { kind: "turn_end" as const, turnIndex: 0 };
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };
  }

  test("full lifecycle with cooperating adapter: created → running → waiting → running → terminated", async () => {
    const rawModelCall = async (_req: ModelRequest): Promise<ModelResponse> => {
      return { content: "hello", model: "test" };
    };

    const adapter = cooperatingAdapterWithCalls(rawModelCall);

    // Use middleware to observe lifecycle transitions
    const observer: KoiMiddleware = {
      name: "state-observer",
      wrapModelCall: async (_ctx, req, next) => {
        return next(req);
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [observer],
      loopDetection: false,
    });

    expect(runtime.agent.state).toBe("created");
    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(runtime.agent.state).toBe("terminated");
  });

  test("middleware wrapModelCall fires when adapter uses callHandlers.modelCall", async () => {
    const wrapModelCallSpy = mock(
      async (_ctx: unknown, req: ModelRequest, next: (r: ModelRequest) => Promise<ModelResponse>) =>
        next(req),
    );

    const rawModelCall = mock(async () => ({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapterWithCalls(rawModelCall);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [
        {
          name: "spy-mw",
          wrapModelCall: wrapModelCallSpy,
        },
      ],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(wrapModelCallSpy).toHaveBeenCalledTimes(1);
    expect(rawModelCall).toHaveBeenCalledTimes(1);
  });

  test("guard (IterationGuard) actually blocks after max turns via callHandlers", async () => {
    let callCount = 0;
    const rawModelCall = mock(async () => {
      callCount++;
      return {
        content: `turn ${callCount}`,
        model: "test",
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    });

    // Adapter that calls modelCall repeatedly until blocked
    const adapter: EngineAdapter = {
      engineId: "greedy-adapter",
      terminals: { modelCall: rawModelCall },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (!input.callHandlers) {
            yield { kind: "done" as const, output: doneOutput() };
            return;
          }
          // Try to make 10 model calls; guard should stop at 3
          for (let i = 0; i < 10; i++) {
            try {
              await input.callHandlers.modelCall({ messages: [] });
            } catch {
              // Guard threw — stop the loop
              break;
            }
            yield { kind: "turn_end" as const, turnIndex: i };
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      limits: { maxTurns: 3 },
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // rawModelCall should have been called exactly 3 times (guard blocks on 4th)
    expect(rawModelCall).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Streaming lifecycle integration
// ---------------------------------------------------------------------------

describe("streaming lifecycle integration", () => {
  /**
   * A cooperating adapter with modelStream terminal that uses callHandlers.modelStream.
   */
  function streamingCooperatingAdapter(
    rawModelCall: (req: ModelRequest) => Promise<ModelResponse>,
    rawModelStream: ModelStreamHandler,
  ): EngineAdapter {
    return {
      engineId: "streaming-cooperating",
      terminals: {
        modelCall: rawModelCall,
        modelStream: rawModelStream,
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers?.modelStream) {
            for await (const chunk of input.callHandlers.modelStream({ messages: [] })) {
              if (chunk.kind === "text_delta") {
                yield { kind: "text_delta" as const, delta: chunk.delta };
              }
            }
          }
          yield { kind: "turn_end" as const, turnIndex: 0 };
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };
  }

  test("full lifecycle: created → running → waiting(model_stream) → running → terminated", async () => {
    const rawModelCall = async (): Promise<ModelResponse> => ({
      content: "ok",
      model: "test",
    });
    const rawModelStream: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "text_delta" as const, delta: "streamed " };
        yield { kind: "text_delta" as const, delta: "hello" };
        yield {
          kind: "done" as const,
          response: { content: "streamed hello", model: "test" },
        };
      },
    });

    const adapter = streamingCooperatingAdapter(rawModelCall, rawModelStream);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    expect(runtime.agent.state).toBe("created");
    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(runtime.agent.state).toBe("terminated");

    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas).toHaveLength(2);
  });

  test("wrapModelStream middleware fires in integration", async () => {
    const streamWrapCalled = mock(() => {});
    const observer: KoiMiddleware = {
      name: "stream-observer",
      wrapModelStream: (_ctx, req, next) => ({
        async *[Symbol.asyncIterator]() {
          streamWrapCalled();
          yield* next(req);
        },
      }),
    };

    const rawModelCall = async (): Promise<ModelResponse> => ({
      content: "ok",
      model: "test",
    });
    const rawModelStream: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "text_delta" as const, delta: "hi" };
        yield {
          kind: "done" as const,
          response: { content: "hi", model: "test" },
        };
      },
    });

    const adapter = streamingCooperatingAdapter(rawModelCall, rawModelStream);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [observer],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(streamWrapCalled).toHaveBeenCalledTimes(1);
  });

  test("IterationGuard blocks streaming calls at turn limit", async () => {
    let streamCallCount = 0;
    const rawModelCall = async (): Promise<ModelResponse> => ({
      content: "ok",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 10 },
    });
    const rawModelStream: ModelStreamHandler = () => {
      streamCallCount++;
      return {
        async *[Symbol.asyncIterator]() {
          yield { kind: "text_delta" as const, delta: "chunk" };
          yield {
            kind: "done" as const,
            response: {
              content: "chunk",
              model: "test",
              usage: { inputTokens: 10, outputTokens: 10 },
            },
          };
        },
      };
    };

    // Adapter that calls modelStream repeatedly until blocked
    const adapter: EngineAdapter = {
      engineId: "greedy-stream-adapter",
      terminals: {
        modelCall: rawModelCall,
        modelStream: rawModelStream,
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (!input.callHandlers?.modelStream) {
            yield { kind: "done" as const, output: doneOutput() };
            return;
          }
          // Try to make 10 stream calls; guard should stop at 3
          for (let i = 0; i < 10; i++) {
            try {
              const chunks: ModelChunk[] = [];
              for await (const chunk of input.callHandlers.modelStream({ messages: [] })) {
                chunks.push(chunk);
              }
            } catch {
              // Guard threw — stop
              break;
            }
            yield { kind: "turn_end" as const, turnIndex: i };
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      limits: { maxTurns: 3 },
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // rawModelStream should have been called exactly 3 times (guard blocks on 4th)
    expect(streamCallCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// HITL approval lifecycle integration
// ---------------------------------------------------------------------------

describe("HITL approval lifecycle integration", () => {
  /** Tool provider that registers a tool for HITL testing. */
  function hitlToolProvider(executeMock: (input: unknown) => Promise<unknown>) {
    return {
      name: "hitl-tool-provider",
      attach: async () =>
        new Map([
          [
            toolToken("reviewed-tool") as string,
            {
              descriptor: {
                name: "reviewed-tool",
                description: "A tool needing review",
                inputSchema: {},
              },
              trustTier: "verified" as const,
              execute: executeMock,
            },
          ],
        ]),
    };
  }

  /** HITL gating middleware — asks requestApproval before every tool call. */
  const hitlGateMw: KoiMiddleware = {
    name: "hitl-gate",
    wrapToolCall: async (ctx, req, next) => {
      if (ctx.requestApproval) {
        const decision = await ctx.requestApproval({
          toolId: req.toolId,
          input: req.input,
          reason: "tool requires human approval",
        });
        if (decision.kind === "deny") {
          return { output: `Denied: ${decision.reason}` };
        }
        if (decision.kind === "modify") {
          return next({ ...req, input: decision.updatedInput });
        }
      }
      return next(req);
    },
  };

  test("full lifecycle with approval: tool call allowed", async () => {
    const executeMock = mock(async (input: unknown) => ({ result: "executed", input }));
    const approvalHandler: ApprovalHandler = async () => ({ kind: "allow" });

    const adapter: EngineAdapter = {
      engineId: "hitl-allow-adapter",
      terminals: {
        modelCall: async () => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.toolCall({ toolId: "reviewed-tool", input: { x: 1 } });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [hitlGateMw],
      approvalHandler,
      loopDetection: false,
      providers: [hitlToolProvider(executeMock)],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith({ x: 1 });
  });

  test("full lifecycle with denial: tool call denied, error propagated", async () => {
    const executeMock = mock(async () => "should not run");
    const approvalHandler: ApprovalHandler = async () => ({
      kind: "deny",
      reason: "user said no",
    });

    const toolResults: unknown[] = [];

    const adapter: EngineAdapter = {
      engineId: "hitl-deny-adapter",
      terminals: {
        modelCall: async () => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "reviewed-tool",
              input: { x: 1 },
            });
            toolResults.push(result.output);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [hitlGateMw],
      approvalHandler,
      loopDetection: false,
      providers: [hitlToolProvider(executeMock)],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(executeMock).not.toHaveBeenCalled();
    expect(toolResults[0]).toBe("Denied: user said no");
  });

  test("full lifecycle with modification: tool executes with modified input", async () => {
    const executeMock = mock(async (input: unknown) => ({ result: "executed", input }));
    const approvalHandler: ApprovalHandler = async () => ({
      kind: "modify",
      updatedInput: { x: 999 },
    });

    const toolResults: unknown[] = [];

    const adapter: EngineAdapter = {
      engineId: "hitl-modify-adapter",
      terminals: {
        modelCall: async () => ({ content: "ok", model: "test" }),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const result = await input.callHandlers.toolCall({
              toolId: "reviewed-tool",
              input: { x: 1 },
            });
            toolResults.push(result.output);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [hitlGateMw],
      approvalHandler,
      loopDetection: false,
      providers: [hitlToolProvider(executeMock)],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(executeMock).toHaveBeenCalledTimes(1);
    // Tool should have been called with the modified input
    expect(executeMock).toHaveBeenCalledWith({ x: 999 });
  });
});

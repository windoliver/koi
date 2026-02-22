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
  ModelHandler,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "./koi.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function testManifest(overrides?: Partial<AgentManifest>): AgentManifest {
  return {
    name: "Test Agent",
    version: "0.1.0",
    model: { name: "test-model" },
    ...overrides,
  };
}

function doneOutput(overrides?: Partial<EngineOutput>): EngineOutput {
  return {
    content: [],
    stopReason: "completed",
    metrics: {
      totalTokens: 10,
      inputTokens: 5,
      outputTokens: 5,
      turns: 1,
      durationMs: 100,
    },
    ...overrides,
  };
}

function mockAdapter(events: readonly EngineEvent[]): EngineAdapter {
  return {
    engineId: "test-adapter",
    stream: () => {
      let index = 0;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              if (index >= events.length) {
                return { done: true, value: undefined };
              }
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

async function collectEvents(iter: AsyncIterable<EngineEvent>): Promise<readonly EngineEvent[]> {
  const events: EngineEvent[] = [];
  for await (const event of iter) {
    events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// createKoi — assembly
// ---------------------------------------------------------------------------

describe("createKoi assembly", () => {
  test("creates a runtime with agent in created state", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });
    expect(runtime.agent).toBeDefined();
    expect(runtime.agent.state).toBe("created");
  });

  test("agent has correct manifest", async () => {
    const manifest = testManifest({ name: "My Bot" });
    const runtime = await createKoi({
      manifest,
      adapter: mockAdapter([]),
    });
    expect(runtime.agent.manifest.name).toBe("My Bot");
  });

  test("agent has correct pid name", async () => {
    const runtime = await createKoi({
      manifest: testManifest({ name: "Test Bot" }),
      adapter: mockAdapter([]),
    });
    expect(runtime.agent.pid.name).toBe("Test Bot");
  });

  test("agent has depth 0", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });
    expect(runtime.agent.pid.depth).toBe(0);
  });

  test("assembles with component providers", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
      providers: [
        {
          name: "test-provider",
          attach: async () => new Map([["test:component", { value: 42 }]]),
        },
      ],
    });
    expect(runtime.agent.has("test:component" as never)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// createKoi — run lifecycle
// ---------------------------------------------------------------------------

describe("createKoi run lifecycle", () => {
  test("transitions agent to running when run starts", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
    });

    expect(runtime.agent.state).toBe("created");

    // Start consuming events
    const iter = runtime.run({ kind: "text", text: "hello" })[Symbol.asyncIterator]();
    await iter.next(); // This triggers the start
    // Agent should now be running or terminated
    expect(["running", "terminated"]).toContain(runtime.agent.state);
  });

  test("transitions agent to terminated when done event received", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "text_delta", delta: "Hello" },
        { kind: "done", output: doneOutput() },
      ]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events.map((e) => e.kind)).toEqual(["text_delta", "done"]);
    expect(runtime.agent.state).toBe("terminated");
  });

  test("yields all events from adapter", async () => {
    const expectedEvents: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "Hello " },
      { kind: "text_delta", delta: "world" },
      { kind: "turn_end", turnIndex: 0 },
      { kind: "done", output: doneOutput() },
    ];

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter(expectedEvents),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events).toEqual(expectedEvents);
  });

  test("handles empty event stream", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events).toEqual([]);
    expect(runtime.agent.state).toBe("terminated");
  });
});

// ---------------------------------------------------------------------------
// createKoi — dispose
// ---------------------------------------------------------------------------

describe("createKoi dispose", () => {
  test("calls adapter dispose", async () => {
    const dispose = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      ...mockAdapter([]),
      dispose,
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
    });

    await runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("dispose is idempotent", async () => {
    const dispose = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      ...mockAdapter([]),
      dispose,
    };
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
    });

    await runtime.dispose();
    await runtime.dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test("handles adapter without dispose", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([]),
    });

    // Should not throw
    await runtime.dispose();
  });
});

// ---------------------------------------------------------------------------
// createKoi — guard integration
// ---------------------------------------------------------------------------

describe("createKoi guard integration", () => {
  test("loop detection can be disabled", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });
    // Should create without error
    expect(runtime.agent).toBeDefined();
  });

  test("custom iteration limits are accepted", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      limits: { maxTurns: 5, maxDurationMs: 10_000, maxTokens: 1000 },
    });
    expect(runtime.agent).toBeDefined();
  });

  test("custom spawn policy is accepted", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      spawn: { maxDepth: 1, maxFanOut: 2, maxTotalProcesses: 5 },
    });
    expect(runtime.agent).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// createKoi — middleware hooks
// ---------------------------------------------------------------------------

describe("createKoi middleware hooks", () => {
  test("calls onSessionStart on user middleware", async () => {
    const onSessionStart = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "test-mw", onSessionStart }],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(onSessionStart).toHaveBeenCalledTimes(1);
  });

  test("calls onSessionEnd on user middleware", async () => {
    const onSessionEnd = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      middleware: [{ name: "test-mw", onSessionEnd }],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("calls onAfterTurn on turn_end events", async () => {
    const onAfterTurn = mock(() => Promise.resolve());
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([
        { kind: "turn_end", turnIndex: 0 },
        { kind: "done", output: doneOutput() },
      ]),
      middleware: [{ name: "test-mw", onAfterTurn }],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(onAfterTurn).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createKoi — terminal injection (cooperating adapter)
// ---------------------------------------------------------------------------

/** Cooperating adapter: exposes terminals, captures input for assertions. */
function cooperatingAdapter(
  modelTerminal: ModelHandler,
  events: readonly EngineEvent[],
): EngineAdapter & { capturedInput?: EngineInput } {
  const result: EngineAdapter & { capturedInput?: EngineInput } = {
    engineId: "cooperating-adapter",
    terminals: {
      modelCall: modelTerminal,
    },
    stream: (input: EngineInput) => {
      result.capturedInput = input;
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
  return result;
}

describe("createKoi terminal injection", () => {
  test("adapter with terminals gets callHandlers in input", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapter(modelTerminal, [{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(adapter.capturedInput).toBeDefined();
    expect(adapter.capturedInput?.callHandlers).toBeDefined();
    expect(typeof adapter.capturedInput?.callHandlers?.modelCall).toBe("function");
    expect(typeof adapter.capturedInput?.callHandlers?.toolCall).toBe("function");
  });

  test("adapter without terminals works normally (no callHandlers)", async () => {
    const adapter = mockAdapter([{ kind: "done", output: doneOutput() }]);
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("done");
  });

  test("default tool terminal finds and executes agent tools", async () => {
    const executeMock = mock(() => Promise.resolve("tool-result"));
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    // Create a cooperating adapter that uses callHandlers.toolCall
    const adapter: EngineAdapter = {
      engineId: "tool-test-adapter",
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => {
        let done = false;
        return {
          async *[Symbol.asyncIterator]() {
            if (!done) {
              done = true;
              // Use the composed tool handler to call our registered tool
              if (input.callHandlers) {
                await input.callHandlers.toolCall({
                  toolId: "calculator",
                  input: { a: 1 },
                });
              }
              yield {
                kind: "done" as const,
                output: doneOutput(),
              };
            }
          },
        };
      },
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("calculator") as string,
                {
                  descriptor: {
                    name: "calculator",
                    description: "Calculate",
                    inputSchema: {},
                  },
                  trustTier: "verified",
                  execute: executeMock,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(executeMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createKoi — duration fix
// ---------------------------------------------------------------------------

describe("createKoi duration fix", () => {
  test("duration is non-zero in error events", async () => {
    // Create adapter that throws a KoiEngineError
    const { KoiEngineError } = await import("./errors.js");
    const adapter: EngineAdapter = {
      engineId: "slow-crash",
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              // Small delay to ensure non-zero duration
              await new Promise((r) => setTimeout(r, 5));
              throw KoiEngineError.from("TIMEOUT", "max turns exceeded");
            },
          };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const doneEvent = events.find((e) => e.kind === "done");
    expect(doneEvent).toBeDefined();
    if (doneEvent?.kind === "done") {
      expect(doneEvent.output.metrics.durationMs).toBeGreaterThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// createKoi — streaming terminal wiring
// ---------------------------------------------------------------------------

/** Helper: cooperating adapter with modelStream terminal. */
function streamingAdapter(
  modelTerminal: ModelHandler,
  modelStreamTerminal: ModelStreamHandler,
  events: readonly EngineEvent[],
): EngineAdapter & { capturedInput?: EngineInput } {
  const result: EngineAdapter & { capturedInput?: EngineInput } = {
    engineId: "streaming-adapter",
    terminals: {
      modelCall: modelTerminal,
      modelStream: modelStreamTerminal,
    },
    stream: (input: EngineInput) => {
      result.capturedInput = input;
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
  return result;
}

describe("createKoi streaming terminal wiring", () => {
  test("adapter with modelStream terminal gets callHandlers.modelStream", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const modelStreamTerminal: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        yield { kind: "done" as const, response: { content: "ok", model: "test" } };
      },
    });
    const adapter = streamingAdapter(modelTerminal, modelStreamTerminal, [
      { kind: "done", output: doneOutput() },
    ]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(adapter.capturedInput).toBeDefined();
    expect(adapter.capturedInput?.callHandlers?.modelStream).toBeDefined();
    expect(typeof adapter.capturedInput?.callHandlers?.modelStream).toBe("function");
  });

  test("adapter without modelStream terminal gets no callHandlers.modelStream", async () => {
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapter(modelTerminal, [{ kind: "done", output: doneOutput() }]);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(adapter.capturedInput).toBeDefined();
    expect(adapter.capturedInput?.callHandlers?.modelStream).toBeUndefined();
  });

  test("adapter can consume callHandlers.modelStream to stream", async () => {
    const streamChunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "Hello" },
      { kind: "done", response: { content: "Hello", model: "test" } },
    ];

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const modelStreamTerminal: ModelStreamHandler = () => ({
      async *[Symbol.asyncIterator]() {
        for (const chunk of streamChunks) {
          yield chunk;
        }
      },
    });

    // Adapter that uses callHandlers.modelStream
    const adapter: EngineAdapter = {
      engineId: "stream-consuming-adapter",
      terminals: {
        modelCall: modelTerminal,
        modelStream: modelStreamTerminal,
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers?.modelStream) {
            const chunks: ModelChunk[] = [];
            for await (const chunk of input.callHandlers.modelStream({ messages: [] })) {
              chunks.push(chunk);
            }
            // Verify we got the expected chunks
            yield {
              kind: "text_delta" as const,
              delta: chunks.map((c) => (c.kind === "text_delta" ? c.delta : "")).join(""),
            };
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    const events = await collectEvents(runtime.run({ kind: "text", text: "test" }));
    const textDeltas = events.filter((e) => e.kind === "text_delta");
    expect(textDeltas).toHaveLength(1);
    if (textDeltas[0]?.kind === "text_delta") {
      expect(textDeltas[0].delta).toBe("Hello");
    }
  });
});

// ---------------------------------------------------------------------------
// createKoi — HITL approval handler wiring
// ---------------------------------------------------------------------------

describe("createKoi HITL approval handler", () => {
  /** Cooperating adapter that actually invokes callHandlers.modelCall, triggering middleware. */
  function cooperatingAdapterWithModelCall(rawModelCall: ModelHandler): EngineAdapter {
    return {
      engineId: "hitl-cooperating",
      terminals: { modelCall: rawModelCall },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.modelCall({ messages: [] });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };
  }

  test("approvalHandler option injects requestApproval into TurnContext", async () => {
    const approvalHandler: ApprovalHandler = async () => ({ kind: "allow" });
    let capturedCtx: TurnContext | undefined;

    const mw: KoiMiddleware = {
      name: "ctx-capture",
      wrapModelCall: async (ctx, req, next) => {
        capturedCtx = ctx;
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapterWithModelCall(modelTerminal);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [mw],
      approvalHandler,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.requestApproval).toBe(approvalHandler);
  });

  test("no approvalHandler means requestApproval is undefined in TurnContext", async () => {
    let capturedCtx: TurnContext | undefined;

    const mw: KoiMiddleware = {
      name: "ctx-capture",
      wrapModelCall: async (ctx, req, next) => {
        capturedCtx = ctx;
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
    const adapter = cooperatingAdapterWithModelCall(modelTerminal);

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [mw],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx?.requestApproval).toBeUndefined();
  });

  test("cooperating adapter middleware can use requestApproval to gate tool calls", async () => {
    const approvalHandler: ApprovalHandler = async (req) => {
      if (req.toolId === "dangerous-tool") {
        return { kind: "deny", reason: "tool is dangerous" };
      }
      return { kind: "allow" };
    };

    const toolResults: unknown[] = [];

    const mw: KoiMiddleware = {
      name: "hitl-gate",
      wrapToolCall: async (ctx, req, next) => {
        if (ctx.requestApproval) {
          const decision = await ctx.requestApproval({
            toolId: req.toolId,
            input: req.input,
            reason: "tool requires approval",
          });
          if (decision.kind === "deny") {
            return { output: `Denied: ${decision.reason}` };
          }
        }
        return next(req);
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    // Adapter that calls two tools — one safe, one dangerous
    const adapter: EngineAdapter = {
      engineId: "hitl-adapter",
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            const safeResult = await input.callHandlers.toolCall({
              toolId: "safe-tool",
              input: {},
            });
            toolResults.push(safeResult.output);

            const dangerousResult = await input.callHandlers.toolCall({
              toolId: "dangerous-tool",
              input: {},
            });
            toolResults.push(dangerousResult.output);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [mw],
      approvalHandler,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () => {
            const { toolToken: tt } = await import("@koi/core");
            return new Map([
              [
                tt("safe-tool") as string,
                {
                  descriptor: { name: "safe-tool", description: "Safe", inputSchema: {} },
                  trustTier: "verified",
                  execute: async () => "safe-result",
                },
              ],
              [
                tt("dangerous-tool") as string,
                {
                  descriptor: { name: "dangerous-tool", description: "Dangerous", inputSchema: {} },
                  trustTier: "verified",
                  execute: async () => "dangerous-result",
                },
              ],
            ]);
          },
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(toolResults).toHaveLength(2);
    expect(toolResults[0]).toBe("safe-result");
    expect(toolResults[1]).toBe("Denied: tool is dangerous");
  });
});

// ---------------------------------------------------------------------------
// createKoi — tool-not-found error path
// ---------------------------------------------------------------------------

describe("createKoi tool not found", () => {
  test("default tool terminal throws NOT_FOUND for missing tool", async () => {
    const { KoiEngineError } = await import("./errors.js");
    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    let caughtError: unknown;
    const adapter: EngineAdapter = {
      engineId: "tool-not-found-adapter",
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            try {
              await input.callHandlers.toolCall({
                toolId: "nonexistent",
                input: {},
              });
            } catch (e: unknown) {
              caughtError = e;
            }
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(caughtError).toBeInstanceOf(KoiEngineError);
    if (caughtError instanceof KoiEngineError) {
      expect(caughtError.code).toBe("NOT_FOUND");
      expect(caughtError.message).toContain("nonexistent");
    }
  });
});

// ---------------------------------------------------------------------------
// createKoi — early return (interrupt)
// ---------------------------------------------------------------------------

describe("createKoi early return", () => {
  test("breaking out of run() transitions agent to terminated:interrupted", async () => {
    // Adapter that yields infinite events
    const adapter: EngineAdapter = {
      engineId: "infinite-adapter",
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          let i = 0;
          while (true) {
            yield { kind: "text_delta" as const, delta: `chunk${i++}` };
          }
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    let count = 0;
    for await (const _event of runtime.run({ kind: "text", text: "test" })) {
      count++;
      if (count >= 3) break;
    }

    expect(count).toBe(3);
    expect(runtime.agent.state).toBe("terminated");
  });

  test("onSessionEnd fires on early return", async () => {
    const onSessionEnd = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      engineId: "infinite-adapter",
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          while (true) {
            yield { kind: "text_delta" as const, delta: "x" };
          }
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [{ name: "test-mw", onSessionEnd }],
      loopDetection: false,
    });

    let count = 0;
    for await (const _event of runtime.run({ kind: "text", text: "test" })) {
      count++;
      if (count >= 1) break;
    }

    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });

  test("unexpected error transitions agent to terminated and fires onSessionEnd", async () => {
    const onSessionEnd = mock(() => Promise.resolve());
    const adapter: EngineAdapter = {
      engineId: "crash-adapter",
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              throw new Error("unexpected crash");
            },
          };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [{ name: "test-mw", onSessionEnd }],
      loopDetection: false,
    });

    await expect(collectEvents(runtime.run({ kind: "text", text: "test" }))).rejects.toThrow(
      "unexpected crash",
    );
    expect(runtime.agent.state).toBe("terminated");
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });
});

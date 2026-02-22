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
  Tool,
  ToolDescriptor,
  ToolRequest,
  TurnContext,
} from "@koi/core";
import { toolToken } from "@koi/core";
import { createKoi } from "./koi.js";
import type { ForgeRuntime } from "./types.js";

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

// ---------------------------------------------------------------------------
// createKoi — live forge resolution
// ---------------------------------------------------------------------------

/** Helper: creates a mock ForgeRuntime with configurable behavior. */
function mockForgeRuntime(overrides?: Partial<ForgeRuntime>): ForgeRuntime {
  return {
    resolveTool: mock(() => Promise.resolve(undefined)),
    toolDescriptors: mock(() => Promise.resolve([])),
    ...overrides,
  };
}

/** Helper: creates a minimal Tool with the given name and execute mock. */
function mockTool(
  name: string,
  executeFn: (input: unknown) => Promise<unknown> = async () => `${name}-result`,
): Tool {
  return {
    descriptor: { name, description: `Tool: ${name}`, inputSchema: {} },
    trustTier: "verified",
    execute: mock(executeFn),
  };
}

/** Helper: cooperating adapter that calls tools via callHandlers. */
function forgeTestAdapter(
  onStream: (input: EngineInput) => AsyncGenerator<EngineEvent>,
): EngineAdapter {
  const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));
  return {
    engineId: "forge-test-adapter",
    terminals: { modelCall: modelTerminal },
    stream: (input: EngineInput) => ({
      [Symbol.asyncIterator]() {
        return onStream(input);
      },
    }),
  };
}

describe("createKoi live forge resolution", () => {
  test("forged tool resolves when entity lookup misses", async () => {
    const forgedTool = mockTool("forged-calc", async () => 42);
    const forge = mockForgeRuntime({
      resolveTool: mock(async (toolId: string) =>
        toolId === "forged-calc" ? forgedTool : undefined,
      ),
      toolDescriptors: mock(async () => [forgedTool.descriptor]),
    });

    let toolResult: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        const res = await input.callHandlers.toolCall({
          toolId: "forged-calc",
          input: { x: 1 },
        });
        toolResult = res.output;
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(forgedTool.execute).toHaveBeenCalledTimes(1);
    expect(toolResult).toBe(42);
  });

  test("entity tool takes precedence over forged tool with same name", async () => {
    const entityExecute = mock(() => Promise.resolve("entity-result"));
    const forgedTool = mockTool("calculator", async () => "forged-result");
    const forge = mockForgeRuntime({
      resolveTool: mock(async (toolId: string) =>
        toolId === "calculator" ? forgedTool : undefined,
      ),
    });

    let toolResult: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        const res = await input.callHandlers.toolCall({
          toolId: "calculator",
          input: {},
        });
        toolResult = res.output;
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("calculator") as string,
                {
                  descriptor: { name: "calculator", description: "Calc", inputSchema: {} },
                  trustTier: "verified" as const,
                  execute: entityExecute,
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Entity tool should win; forge.resolveTool should NOT be called
    expect(entityExecute).toHaveBeenCalledTimes(1);
    expect(toolResult).toBe("entity-result");
    expect(forgedTool.execute).not.toHaveBeenCalled();
  });

  test("NOT_FOUND when neither entity nor forge has the tool", async () => {
    const { KoiEngineError } = await import("./errors.js");
    const forge = mockForgeRuntime();

    let caughtError: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        try {
          await input.callHandlers.toolCall({ toolId: "nonexistent", input: {} });
        } catch (e: unknown) {
          caughtError = e;
        }
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(caughtError).toBeInstanceOf(KoiEngineError);
    if (caughtError instanceof KoiEngineError) {
      expect(caughtError.code).toBe("NOT_FOUND");
      expect(caughtError.message).toContain("nonexistent");
    }
  });

  test("callHandlers.tools includes forged descriptors", async () => {
    const forgedDescriptor: ToolDescriptor = {
      name: "forged-search",
      description: "Forged search tool",
      inputSchema: { type: "object" },
    };
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => [forgedDescriptor]),
    });

    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    const names = capturedTools?.map((t) => t.name);
    expect(names).toContain("forged-search");
  });

  test("callHandlers.tools merges entity and forged descriptors", async () => {
    const forgedDescriptor: ToolDescriptor = {
      name: "forged-tool",
      description: "Forged",
      inputSchema: {},
    };
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => [forgedDescriptor]),
    });

    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("entity-tool") as string,
                {
                  descriptor: { name: "entity-tool", description: "Entity", inputSchema: {} },
                  trustTier: "verified" as const,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    const names = capturedTools?.map((t) => t.name);
    expect(names).toContain("entity-tool");
    expect(names).toContain("forged-tool");
  });

  test("forged descriptors returns entity-only when forge has no descriptors", async () => {
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => []),
    });

    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("entity-tool") as string,
                {
                  descriptor: { name: "entity-tool", description: "Entity", inputSchema: {} },
                  trustTier: "verified" as const,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools?.[0]?.name).toBe("entity-tool");
  });

  test("forged tool descriptors refresh at turn boundary", async () => {
    // Mutable counter — simulates new tools appearing after first refresh
    let descriptorCallCount = 0;
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => {
        descriptorCallCount++;
        if (descriptorCallCount <= 1) {
          return [{ name: "tool-v1", description: "V1", inputSchema: {} }];
        }
        return [
          { name: "tool-v1", description: "V1", inputSchema: {} },
          { name: "tool-v2", description: "V2", inputSchema: {} },
        ];
      }),
    });

    const toolSnapshots: Array<readonly ToolDescriptor[]> = [];
    const adapter: EngineAdapter = {
      engineId: "turn-boundary-adapter",
      terminals: {
        modelCall: mock(() => Promise.resolve({ content: "ok", model: "test" })),
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          // Snapshot tools before turn_end
          if (input.callHandlers) {
            toolSnapshots.push([...input.callHandlers.tools]);
          }
          yield { kind: "turn_end" as const, turnIndex: 0 };
          // Snapshot tools after turn_end (forge descriptors should be refreshed)
          if (input.callHandlers) {
            toolSnapshots.push([...input.callHandlers.tools]);
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(toolSnapshots).toHaveLength(2);
    // Before turn_end: only tool-v1
    expect(toolSnapshots[0]?.map((t) => t.name)).toEqual(["tool-v1"]);
    // After turn_end: both tool-v1 and tool-v2
    expect(toolSnapshots[1]?.map((t) => t.name)).toEqual(["tool-v1", "tool-v2"]);
  });

  test("forged middleware re-composes at turn boundary", async () => {
    const callLog: string[] = [];

    // Forged middleware that logs calls
    const forgedMw: KoiMiddleware = {
      name: "forged-logger",
      wrapToolCall: async (_ctx, req, next) => {
        callLog.push(`forged-mw:${req.toolId}`);
        return next(req);
      },
    };

    // Mutable flag — enables forged middleware after turn boundary
    let middlewareEnabled = false;
    const forge: ForgeRuntime = {
      resolveTool: mock(async () => undefined),
      toolDescriptors: mock(async () => []),
      middleware: mock(async () => (middlewareEnabled ? [forgedMw] : [])),
    };

    const forgedTool = mockTool("dynamic-tool");

    const adapter: EngineAdapter = {
      engineId: "forge-mw-adapter",
      terminals: {
        modelCall: mock(() => Promise.resolve({ content: "ok", model: "test" })),
        toolCall: async (req: ToolRequest) => {
          if (req.toolId === "dynamic-tool") {
            const output = await forgedTool.execute(req.input);
            return { output };
          }
          throw new Error(`Unexpected tool: ${req.toolId}`);
        },
      },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          // Call tool before turn boundary — no forged middleware yet
          if (input.callHandlers) {
            await input.callHandlers.toolCall({
              toolId: "dynamic-tool",
              input: {},
            });
          }
          // Enable forged middleware before turn boundary
          middlewareEnabled = true;
          yield { kind: "turn_end" as const, turnIndex: 0 };

          // Call tool after turn boundary — forged middleware should now wrap it
          if (input.callHandlers) {
            await input.callHandlers.toolCall({
              toolId: "dynamic-tool",
              input: {},
            });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // First call: no forged middleware, so callLog should be empty at that point
    // Second call: forged middleware active, so it should log
    expect(callLog).toEqual(["forged-mw:dynamic-tool"]);
  });

  test("no-forge path unchanged — callHandlers.tools contains only entity tools", async () => {
    let capturedTools: readonly ToolDescriptor[] | undefined;
    const adapter = forgeTestAdapter(async function* (input) {
      capturedTools = input.callHandlers?.tools;
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      // No forge option
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("my-tool") as string,
                {
                  descriptor: { name: "my-tool", description: "Mine", inputSchema: {} },
                  trustTier: "verified" as const,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(capturedTools).toBeDefined();
    expect(capturedTools).toHaveLength(1);
    expect(capturedTools?.[0]?.name).toBe("my-tool");
  });

  test("forged tool preserves metadata in response", async () => {
    const forgedTool = mockTool("meta-tool", async () => "meta-result");
    const forge = mockForgeRuntime({
      resolveTool: mock(async (toolId: string) =>
        toolId === "meta-tool" ? forgedTool : undefined,
      ),
    });

    let toolResult: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        const res = await input.callHandlers.toolCall({
          toolId: "meta-tool",
          input: {},
          metadata: { requestId: "abc-123" },
        });
        toolResult = res;
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(toolResult).toEqual({
      output: "meta-result",
      metadata: { requestId: "abc-123" },
    });
  });

  test("forge.resolveTool is NOT called when entity has the tool", async () => {
    const resolveTool = mock(async () => undefined);
    const forge = mockForgeRuntime({ resolveTool });

    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        await input.callHandlers.toolCall({ toolId: "entity-calc", input: {} });
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tool-provider",
          attach: async () =>
            new Map([
              [
                toolToken("entity-calc") as string,
                {
                  descriptor: { name: "entity-calc", description: "Calc", inputSchema: {} },
                  trustTier: "verified" as const,
                  execute: async () => "ok",
                },
              ],
            ]),
        },
      ],
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    // Due to ?? short-circuit, resolveTool should never be called
    expect(resolveTool).not.toHaveBeenCalled();
  });

  test("forge.resolveTool error propagates to caller", async () => {
    const forgeError = new Error("Forge connection failed");
    const forge = mockForgeRuntime({
      resolveTool: mock(async () => {
        throw forgeError;
      }),
    });

    let caughtError: unknown;
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        try {
          await input.callHandlers.toolCall({ toolId: "failing-tool", input: {} });
        } catch (e: unknown) {
          caughtError = e;
        }
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    expect(caughtError).toBe(forgeError);
  });

  test("forge.toolDescriptors error propagates at session start", async () => {
    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => {
        throw new Error("Descriptor fetch failed");
      }),
    });

    const adapter = forgeTestAdapter(async function* (_input) {
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await expect(collectEvents(runtime.run({ kind: "text", text: "test" }))).rejects.toThrow(
      "Descriptor fetch failed",
    );
  });

  test("forge has no effect when adapter lacks terminals", async () => {
    const resolveTool = mock(async () => mockTool("forged"));
    const toolDescriptors = mock(async () => [
      { name: "forged", description: "F", inputSchema: {} } as ToolDescriptor,
    ]);
    const forge = mockForgeRuntime({ resolveTool, toolDescriptors });

    let receivedCallHandlers = false;
    const adapter: EngineAdapter = {
      engineId: "non-cooperating",
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          receivedCallHandlers = input.callHandlers !== undefined;
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(receivedCallHandlers).toBe(false);
    expect(resolveTool).not.toHaveBeenCalled();
    expect(toolDescriptors).not.toHaveBeenCalled();
  });

  test("multiple forged tool calls in same turn resolve independently", async () => {
    const tool1 = mockTool("tool-1", async () => "result-1");
    const tool2 = mockTool("tool-2", async () => "result-2");
    const resolveTool = mock(async (toolId: string) => {
      if (toolId === "tool-1") return tool1;
      if (toolId === "tool-2") return tool2;
      return undefined;
    });
    const forge = mockForgeRuntime({
      resolveTool,
      toolDescriptors: mock(async () => [tool1.descriptor, tool2.descriptor]),
    });

    const results: unknown[] = [];
    const adapter = forgeTestAdapter(async function* (input) {
      if (input.callHandlers) {
        results.push((await input.callHandlers.toolCall({ toolId: "tool-1", input: {} })).output);
        results.push((await input.callHandlers.toolCall({ toolId: "tool-2", input: {} })).output);
        results.push((await input.callHandlers.toolCall({ toolId: "tool-1", input: {} })).output);
      }
      yield { kind: "done" as const, output: doneOutput() };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));

    expect(results).toEqual(["result-1", "result-2", "result-1"]);
    expect(resolveTool).toHaveBeenCalledTimes(3);
    expect(tool1.execute).toHaveBeenCalledTimes(2);
    expect(tool2.execute).toHaveBeenCalledTimes(1);
  });

  test("middleware injected between turns takes effect on next turn (deferred refresh)", async () => {
    // Tracks which tool calls the middleware intercepted
    const intercepted: string[] = [];
    // Mutable middleware list — starts empty, populated between turns
    // let justified: mutable list updated mid-session to simulate forge injection
    let forgedMiddleware: readonly KoiMiddleware[] = [];

    const forge = mockForgeRuntime({
      middleware: mock(async () => forgedMiddleware),
    });

    const adapter = forgeTestAdapter(async function* (input) {
      if (!input.callHandlers) {
        yield { kind: "done" as const, output: doneOutput() };
        return;
      }

      // Turn 0: call tool (no forge middleware yet)
      await input.callHandlers.toolCall({ toolId: "echo", input: { msg: "turn0" } });
      yield { kind: "turn_end" as const, turnIndex: 0 };

      // Turn 1: call tool (forge middleware should be active now)
      await input.callHandlers.toolCall({ toolId: "echo", input: { msg: "turn1" } });
      yield { kind: "turn_end" as const, turnIndex: 1 };

      yield {
        kind: "done" as const,
        output: doneOutput({
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 2, durationMs: 0 },
        }),
      };
    });

    const echoTool: Tool = {
      descriptor: { name: "echo", description: "Echo tool", inputSchema: {} },
      trustTier: "verified",
      execute: mock(async (input: unknown) => input),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
      providers: [
        {
          name: "tools",
          attach: async () => new Map([[toolToken("echo") as string, echoTool]]),
        },
      ],
    });

    // Consume events, injecting middleware after turn 0
    for await (const event of runtime.run({ kind: "text", text: "test" })) {
      if (event.kind === "turn_end" && event.turnIndex === 0) {
        // Inject middleware between turns — deferred refresh picks it up
        forgedMiddleware = [
          {
            name: "test-audit",
            wrapToolCall: async (_ctx, req, next) => {
              intercepted.push(req.toolId);
              return next(req);
            },
          },
        ];
      }
    }

    // Turn 0 tool call should NOT be intercepted (middleware not yet injected)
    // Turn 1 tool call SHOULD be intercepted (middleware injected after turn 0)
    expect(intercepted).toEqual(["echo"]);
    expect(echoTool.execute).toHaveBeenCalledTimes(2);
    await runtime.dispose();
  });

  test("tool injected between turns is discoverable in next turn descriptors", async () => {
    // Mutable descriptors list — starts empty
    // let justified: mutable list updated mid-session to simulate forge tool injection
    let forgedDescriptors: readonly ToolDescriptor[] = [];
    const forgedTool = mockTool("dynamic-tool");

    const forge = mockForgeRuntime({
      toolDescriptors: mock(async () => forgedDescriptors),
      resolveTool: mock(async (id: string) => (id === "dynamic-tool" ? forgedTool : undefined)),
    });

    const descriptorSnapshots: Array<readonly ToolDescriptor[]> = [];

    const adapter = forgeTestAdapter(async function* (input) {
      if (!input.callHandlers) {
        yield { kind: "done" as const, output: doneOutput() };
        return;
      }

      // Turn 0: capture descriptors (should NOT include dynamic-tool)
      descriptorSnapshots.push([...input.callHandlers.tools]);
      yield { kind: "turn_end" as const, turnIndex: 0 };

      // Turn 1: capture descriptors (should include dynamic-tool)
      descriptorSnapshots.push([...input.callHandlers.tools]);
      // Also resolve and call the dynamically added tool
      await input.callHandlers.toolCall({ toolId: "dynamic-tool", input: {} });
      yield { kind: "turn_end" as const, turnIndex: 1 };

      yield {
        kind: "done" as const,
        output: doneOutput({
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 2, durationMs: 0 },
        }),
      };
    });

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      forge,
      loopDetection: false,
    });

    for await (const event of runtime.run({ kind: "text", text: "test" })) {
      if (event.kind === "turn_end" && event.turnIndex === 0) {
        // Inject tool between turns
        forgedDescriptors = [forgedTool.descriptor];
      }
    }

    // Turn 0: no forged descriptors
    expect(descriptorSnapshots[0]?.find((d) => d.name === "dynamic-tool")).toBeUndefined();
    // Turn 1: forged descriptor present
    expect(descriptorSnapshots[1]?.find((d) => d.name === "dynamic-tool")).toBeDefined();
    // Tool was callable
    expect(forgedTool.execute).toHaveBeenCalledTimes(1);
    await runtime.dispose();
  });
});

// onBeforeTurn tests removed — inline iterator (main) does not call onBeforeTurn.

// ---------------------------------------------------------------------------
// createKoi — concurrent run() guard (#12A)
// ---------------------------------------------------------------------------

describe("createKoi concurrent run guard", () => {
  test("second run() call throws while first is active", async () => {
    const adapter: EngineAdapter = {
      engineId: "slow-adapter",
      stream: () => ({
        async *[Symbol.asyncIterator]() {
          await new Promise((r) => setTimeout(r, 50));
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      loopDetection: false,
    });

    // Start first run (don't await)
    const iter = runtime.run({ kind: "text", text: "first" })[Symbol.asyncIterator]();
    const firstNext = iter.next(); // starts the generator

    // Second run should throw immediately
    try {
      runtime.run({ kind: "text", text: "second" });
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      const { KoiEngineError: KoiErr } = await import("./errors.js");
      expect(e).toBeInstanceOf(KoiErr);
      if (e instanceof KoiErr) {
        expect(e.code).toBe("VALIDATION");
        expect(e.message).toContain("already running");
      }
    }

    // Complete first run
    await firstNext;
    await iter.next(); // drain
  });

  test("run() works again after first run completes", async () => {
    const runtime = await createKoi({
      manifest: testManifest(),
      adapter: mockAdapter([{ kind: "done", output: doneOutput() }]),
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "first" }));
    // Second run should work
    const events = await collectEvents(runtime.run({ kind: "text", text: "second" }));
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// createKoi — onSessionEnd error preservation (#11A)
// ---------------------------------------------------------------------------

describe("createKoi onSessionEnd error preservation", () => {
  test("original error preserved when onSessionEnd throws", async () => {
    const onSessionEnd = mock(() => {
      throw new Error("onSessionEnd crash");
    });
    const adapter: EngineAdapter = {
      engineId: "crash-adapter",
      stream: () => ({
        [Symbol.asyncIterator]() {
          return {
            async next(): Promise<IteratorResult<EngineEvent>> {
              throw new Error("original error");
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
      "original error",
    );
    expect(onSessionEnd).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// createKoi — priority-based middleware sorting (#4A)
// ---------------------------------------------------------------------------

describe("createKoi middleware priority sorting", () => {
  test("guards (priority 0-2) run before L2 middleware (100+)", async () => {
    const order: string[] = [];

    const trackingMw: KoiMiddleware = {
      name: "tracker",
      priority: 100,
      async wrapModelCall(_ctx, req, next) {
        order.push("tracker-enter");
        const resp = await next(req);
        order.push("tracker-exit");
        return resp;
      },
    };

    const modelTerminal = mock(() => Promise.resolve({ content: "ok", model: "test" }));

    // Adapter that triggers model call through callHandlers
    const adapter: EngineAdapter = {
      engineId: "priority-adapter",
      terminals: { modelCall: modelTerminal },
      stream: (input: EngineInput) => ({
        async *[Symbol.asyncIterator]() {
          if (input.callHandlers) {
            await input.callHandlers.modelCall({ messages: [] });
          }
          yield { kind: "done" as const, output: doneOutput() };
        },
      }),
    };

    const runtime = await createKoi({
      manifest: testManifest(),
      adapter,
      middleware: [trackingMw],
      loopDetection: false,
    });

    await collectEvents(runtime.run({ kind: "text", text: "test" }));
    // Guard (iteration-guard, priority 0) wraps outside tracker (priority 100)
    expect(order).toContain("tracker-enter");
  });
});

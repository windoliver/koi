import { describe, expect, test } from "bun:test";
import type {
  JsonObject,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  RichTrajectoryStep,
  SessionContext,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import type { TraceWrapperConfig } from "./trace-wrapper.js";
import { wrapMiddlewareWithTrace } from "./trace-wrapper.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurnCtx(): TurnContext {
  return {
    session: {
      agentId: "test-agent",
      sessionId: "sid" as never,
      runId: "rid" as never,
      metadata: {},
    },
    turnIndex: 0,
    turnId: "tid" as never,
    messages: [],
    metadata: {},
  };
}

function createMockStore(): {
  readonly steps: RichTrajectoryStep[];
  readonly config: TraceWrapperConfig;
} {
  const steps: RichTrajectoryStep[] = [];
  return {
    steps,
    config: {
      store: {
        append: async (_docId: string, newSteps: readonly RichTrajectoryStep[]) => {
          steps.push(...newSteps);
        },
      } as never,
      docId: "test-doc",
    },
  };
}

function createMockStoreWithDeltas(): {
  readonly steps: RichTrajectoryStep[];
  readonly config: TraceWrapperConfig;
} {
  const steps: RichTrajectoryStep[] = [];
  return {
    steps,
    config: {
      store: {
        append: async (_docId: string, newSteps: readonly RichTrajectoryStep[]) => {
          steps.push(...newSteps);
        },
      } as never,
      docId: "test-doc",
      captureDeltas: true,
    },
  };
}

function makeModelRequest(overrides?: Partial<ModelRequest>): ModelRequest {
  return {
    messages: [
      {
        senderId: "user",
        content: [{ kind: "text", text: "hello" }],
        timestamp: 0,
      },
    ],
    temperature: 0.7,
    maxTokens: 100,
    ...overrides,
  } as ModelRequest;
}

// ---------------------------------------------------------------------------
// B2: Middleware delta capture
// ---------------------------------------------------------------------------

describe("trace-wrapper delta capture", () => {
  test("records model request delta when middleware modifies request and captureDeltas is true", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const modifyingMiddleware: KoiMiddleware = {
      name: "temp-override",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) => {
        const { maxTokens: _, ...rest } = request;
        return next({ ...rest, temperature: 0.3 });
      },
    };

    const wrapped = wrapMiddlewareWithTrace(modifyingMiddleware, config);
    const originalRequest = makeModelRequest();
    const response = {
      content: "ok",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 5 },
    } as ModelResponse;
    const next = async (_req: ModelRequest): Promise<ModelResponse> => response;

    const ctx = makeTurnCtx();
    await wrapped.wrapModelCall?.(ctx, originalRequest, next);

    // Issue 13: flush the buffer (spans are batched per-turn, written in onAfterTurn)
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.type).toBe("middleware_span");

    const delta = meta.requestDelta as JsonObject;
    expect(delta).toBeDefined();
    const changed = delta.changed as JsonObject;
    expect(changed.temperature).toEqual({ fromType: "number", toType: "number" });
  });

  test("records tool input delta when middleware modifies tool input and captureDeltas is true", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const sanitizer: KoiMiddleware = {
      name: "sanitizer",
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, request, next) => {
        return next({
          ...request,
          input: { ...request.input, sanitized: true },
        });
      },
    };

    const wrapped = wrapMiddlewareWithTrace(sanitizer, config);
    const request: ToolRequest = {
      toolId: "bash",
      input: { command: "ls" },
    } as never;
    const response: ToolResponse = { output: "file.txt" };
    const next = async (_req: ToolRequest): Promise<ToolResponse> => response;

    const toolCtx = makeTurnCtx();
    await wrapped.wrapToolCall?.(toolCtx, request, next);

    // Flush the per-turn buffer
    await wrapped.onAfterTurn?.(toolCtx);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    const delta = meta.inputDelta as JsonObject;
    expect(delta).toBeDefined();
    const added = delta.added as JsonObject;
    expect(added.sanitized).toBe("boolean");
  });

  test("no delta field when captureDeltas is false (default)", async () => {
    const { steps, config } = createMockStore();

    const modifyingMiddleware: KoiMiddleware = {
      name: "temp-override",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) => {
        return next({ ...request, temperature: 0.3 });
      },
    };

    const wrapped = wrapMiddlewareWithTrace(modifyingMiddleware, config);
    const response = {
      content: "ok",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 5 },
    } as ModelResponse;

    const noopCtx = makeTurnCtx();
    await wrapped.wrapModelCall?.(noopCtx, makeModelRequest(), async () => response);

    await wrapped.onAfterTurn?.(noopCtx);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.requestDelta).toBeUndefined();
  });

  test("no delta field when middleware does not modify the request", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const passthrough: KoiMiddleware = {
      name: "passthrough",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) => {
        return next(request);
      },
    };

    const wrapped = wrapMiddlewareWithTrace(passthrough, config);
    const response = {
      content: "ok",
      model: "test",
      usage: { inputTokens: 10, outputTokens: 5 },
    } as ModelResponse;

    const noopCtx = makeTurnCtx();
    await wrapped.wrapModelCall?.(noopCtx, makeModelRequest(), async () => response);

    await wrapped.onAfterTurn?.(noopCtx);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.requestDelta).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue 9: ctx.reportDecision injection — unit test
// ---------------------------------------------------------------------------

describe("trace-wrapper: ctx.reportDecision injection", () => {
  test("decisions reported via ctx.reportDecision appear in span metadata", async () => {
    const { steps, config } = createMockStore();

    const decidingMiddleware: KoiMiddleware = {
      name: "decider",
      describeCapabilities: () => undefined,
      wrapToolCall: async (ctx, request, next) => {
        // Middleware calls reportDecision inline during the hook
        ctx.reportDecision?.({ action: "allow", rule: "test-rule", toolId: request.toolId });
        return next(request);
      },
    };

    const wrapped = wrapMiddlewareWithTrace(decidingMiddleware, config);
    const request: ToolRequest = { toolId: "bash", input: { command: "ls" } } as never;
    const ctx = makeTurnCtx();

    await wrapped.wrapToolCall?.(ctx, request, async () => ({ output: "ok" }));
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBe(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.type).toBe("middleware_span");
    const decisions = meta.decisions as JsonObject[];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.action).toBe("allow");
    expect(decisions[0]?.rule).toBe("test-rule");
    expect(decisions[0]?.toolId).toBe("bash");
  });

  test("span has no decisions key when middleware never calls reportDecision", async () => {
    const { steps, config } = createMockStore();

    const silentMiddleware: KoiMiddleware = {
      name: "silent",
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, request, next) => next(request),
    };

    const wrapped = wrapMiddlewareWithTrace(silentMiddleware, config);
    const ctx = makeTurnCtx();
    await wrapped.wrapToolCall?.(ctx, { toolId: "foo", input: {} } as never, async () => ({
      output: "ok",
    }));
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBe(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.decisions).toBeUndefined();
  });

  test("multiple reportDecision calls accumulate as an array", async () => {
    const { steps, config } = createMockStore();

    const multiDecider: KoiMiddleware = {
      name: "multi",
      describeCapabilities: () => undefined,
      wrapToolCall: async (ctx, request, next) => {
        ctx.reportDecision?.({ phase: "input-scan", matchCount: 0 });
        const response = await next(request);
        ctx.reportDecision?.({ phase: "output-scan", matchCount: 2, action: "redact" });
        return response;
      },
    };

    const wrapped = wrapMiddlewareWithTrace(multiDecider, config);
    const ctx = makeTurnCtx();
    await wrapped.wrapToolCall?.(ctx, { toolId: "foo", input: {} } as never, async () => ({
      output: "secret",
    }));
    await wrapped.onAfterTurn?.(ctx);

    const decisions = (steps[0]?.metadata as JsonObject).decisions as JsonObject[];
    expect(decisions).toHaveLength(2);
    expect(decisions[0]?.phase).toBe("input-scan");
    expect(decisions[1]?.phase).toBe("output-scan");
    expect(decisions[1]?.action).toBe("redact");
  });
});

// ---------------------------------------------------------------------------
// Issue 10: concurrent call isolation
// ---------------------------------------------------------------------------

describe("trace-wrapper: concurrent wrapToolCall isolation", () => {
  test("two concurrent wrapToolCall invocations produce independent decisions arrays", async () => {
    const { steps, config } = createMockStore();

    const decidingMiddleware: KoiMiddleware = {
      name: "concurrent-decider",
      describeCapabilities: () => undefined,
      wrapToolCall: async (ctx, request, next) => {
        // Simulate async work before reporting
        await new Promise((r) => setTimeout(r, 5));
        ctx.reportDecision?.({ callId: request.toolId });
        return next(request);
      },
    };

    const wrapped = wrapMiddlewareWithTrace(decidingMiddleware, config);
    const ctx = makeTurnCtx();

    // Fire two concurrent calls
    await Promise.all([
      wrapped.wrapToolCall?.(ctx, { toolId: "tool-A", input: {} } as never, async () => ({
        output: "a",
      })),
      wrapped.wrapToolCall?.(ctx, { toolId: "tool-B", input: {} } as never, async () => ({
        output: "b",
      })),
    ]);
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBe(2);

    // Each span must have exactly its own decision — no cross-contamination
    const spanA = steps.find(
      (s) => (s.metadata?.decisions as JsonObject[] | undefined)?.[0]?.callId === "tool-A",
    );
    const spanB = steps.find(
      (s) => (s.metadata?.decisions as JsonObject[] | undefined)?.[0]?.callId === "tool-B",
    );

    expect(spanA).toBeDefined();
    expect(spanB).toBeDefined();
    // Each span has exactly one decision
    expect((spanA?.metadata?.decisions as JsonObject[]).length).toBe(1);
    expect((spanB?.metadata?.decisions as JsonObject[]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Issue 12: decisions preserved on failure path
// ---------------------------------------------------------------------------

describe("trace-wrapper: decisions preserved on throw", () => {
  test("reportDecision calls before a throw are preserved in the failure span", async () => {
    const { steps, config } = createMockStore();

    const throwingMiddleware: KoiMiddleware = {
      name: "thrower",
      describeCapabilities: () => undefined,
      wrapToolCall: async (ctx, _request, _next) => {
        ctx.reportDecision?.({ phase: "pre-throw", decision: "deny" });
        throw new Error("blocked by policy");
      },
    };

    const wrapped = wrapMiddlewareWithTrace(throwingMiddleware, config);
    const ctx = makeTurnCtx();

    await expect(
      wrapped.wrapToolCall?.(ctx, { toolId: "bash", input: {} } as never, async () => ({
        output: "ok",
      })),
    ).rejects.toThrow("blocked by policy");

    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBe(1);
    const meta = steps[0]?.metadata as JsonObject;
    // Failure span recorded correctly
    expect(steps[0]?.outcome).toBe("failure");
    // Decisions accumulated before the throw are preserved
    const decisions = meta.decisions as JsonObject[];
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.phase).toBe("pre-throw");
    expect(decisions[0]?.decision).toBe("deny");
  });
});

// ---------------------------------------------------------------------------
// wrapModelStream recording
// ---------------------------------------------------------------------------

function makeSessionCtx(): SessionContext {
  return {
    agentId: "test-agent",
    sessionId: "sid" as never,
    runId: "rid" as never,
    metadata: {},
  };
}

describe("trace-wrapper: wrapModelStream recording", () => {
  test("records success span when stream is fully consumed", async () => {
    const { steps, config } = createMockStore();

    const passStream: KoiMiddleware = {
      name: "stream-pass",
      describeCapabilities: () => undefined,
      wrapModelStream: (_ctx, request, next) => next(request),
    };

    const wrapped = wrapMiddlewareWithTrace(passStream, config);
    const ctx = makeTurnCtx();
    const chunk = {
      kind: "done",
      response: { content: "hi", model: "m" },
    } as unknown as ModelChunk;
    const next = (_req: ModelRequest): AsyncIterable<ModelChunk> =>
      (async function* () {
        yield chunk;
      })();

    const stream = wrapped.wrapModelStream?.(ctx, makeModelRequest(), next);
    if (stream !== undefined) {
      for await (const _ of stream) {
        /* consume */
      }
    }
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    expect(meta.type).toBe("middleware_span");
    expect(meta.hook).toBe("wrapModelStream");
    expect(steps[0]?.outcome).toBe("success");
  });

  test("records failure span when stream throws", async () => {
    const { steps, config } = createMockStore();

    const throwStream: KoiMiddleware = {
      name: "stream-throw",
      describeCapabilities: () => undefined,
      // Returns an AsyncIterable whose first next() rejects — simulates a stream failure
      wrapModelStream: (): AsyncIterable<ModelChunk> => ({
        [Symbol.asyncIterator](): AsyncIterator<ModelChunk> {
          return {
            next(): Promise<IteratorResult<ModelChunk>> {
              return Promise.reject(new Error("stream error"));
            },
          };
        },
      }),
    };

    const wrapped = wrapMiddlewareWithTrace(throwStream, config);
    const ctx = makeTurnCtx();
    // next is never called because throwStream ignores it
    const next = (): AsyncIterable<ModelChunk> => ({
      [Symbol.asyncIterator](): AsyncIterator<ModelChunk> {
        return {
          next: (): Promise<IteratorResult<ModelChunk>> =>
            Promise.resolve({ done: true, value: undefined as unknown as ModelChunk }),
        };
      },
    });

    const stream = wrapped.wrapModelStream?.(ctx, makeModelRequest(), next);
    if (stream !== undefined) {
      await expect(
        (async () => {
          for await (const _ of stream) {
            /* consume */
          }
        })(),
      ).rejects.toThrow("stream error");
    }
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    expect(steps[0]?.outcome).toBe("failure");
  });

  test("records success span when consumer breaks early (generator closed)", async () => {
    const { steps, config } = createMockStore();

    const infiniteStream: KoiMiddleware = {
      name: "stream-infinite",
      describeCapabilities: () => undefined,
      wrapModelStream: (_ctx, _request, _next) =>
        (async function* () {
          // Infinite stream — consumer will break after first chunk
          while (true) {
            yield { kind: "text", text: "chunk" } as unknown as ModelChunk;
          }
        })(),
    };

    const wrapped = wrapMiddlewareWithTrace(infiniteStream, config);
    const ctx = makeTurnCtx();
    const next = (_req: ModelRequest): AsyncIterable<ModelChunk> => (async function* () {})();

    const stream = wrapped.wrapModelStream?.(ctx, makeModelRequest(), next);
    if (stream !== undefined) {
      // Consume only the first chunk, then break — triggers the finally block
      for await (const _ of stream) {
        break;
      }
    }
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    // Early-exit via break is still recorded as success (not failure)
    expect(steps[0]?.outcome).toBe("success");
  });

  test("stream delta captured when middleware modifies request and captureDeltas is true", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const tempOverrideStream: KoiMiddleware = {
      name: "stream-temp",
      describeCapabilities: () => undefined,
      wrapModelStream: (_ctx, request, next) => next({ ...request, temperature: 0.1 }),
    };

    const wrapped = wrapMiddlewareWithTrace(tempOverrideStream, config);
    const ctx = makeTurnCtx();
    const chunk = {
      kind: "done",
      response: { content: "ok", model: "m" },
    } as unknown as ModelChunk;
    const next = (_req: ModelRequest): AsyncIterable<ModelChunk> =>
      (async function* () {
        yield chunk;
      })();

    const stream = wrapped.wrapModelStream?.(ctx, makeModelRequest(), next);
    if (stream !== undefined) {
      for await (const _ of stream) {
        /* consume */
      }
    }
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const meta = steps[0]?.metadata as JsonObject;
    const delta = meta.requestDelta as JsonObject;
    expect(delta).toBeDefined();
    const changed = delta.changed as JsonObject;
    expect(changed.temperature).toEqual({ fromType: "number", toType: "number" });
  });
});

// ---------------------------------------------------------------------------
// onSessionEnd flush
// ---------------------------------------------------------------------------

describe("trace-wrapper: onSessionEnd", () => {
  test("flushes buffered spans on session end (no onAfterTurn called)", async () => {
    const { steps, config } = createMockStore();

    const mw: KoiMiddleware = {
      name: "session-flush",
      describeCapabilities: () => undefined,
      wrapToolCall: async (_ctx, request, next) => next(request),
    };

    const wrapped = wrapMiddlewareWithTrace(mw, config);
    const ctx = makeTurnCtx();
    // Buffer a span without flushing via onAfterTurn
    await wrapped.wrapToolCall?.(ctx, { toolId: "foo", input: {} } as never, async () => ({
      output: "ok",
    }));
    // onSessionEnd should flush the buffer
    await wrapped.onSessionEnd?.(makeSessionCtx());

    expect(steps.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Delta edge cases: removed key, messages changed, tools changed
// ---------------------------------------------------------------------------

describe("trace-wrapper delta edge cases", () => {
  test("records removed key in metadata delta when middleware strips a metadata field", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const metaStripper: KoiMiddleware = {
      name: "meta-stripper",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) => {
        // Remove a metadata key — triggers shallowDiff removed path on metadataSnapshot
        const { extraKey: _k, ...restMeta } = (request.metadata ?? {}) as { extraKey?: string };
        return next({ ...request, metadata: restMeta as JsonObject });
      },
    };

    const wrapped = wrapMiddlewareWithTrace(metaStripper, config);
    const ctx = makeTurnCtx();
    // Provide a request with metadata that will be stripped
    const reqWithMeta = makeModelRequest({
      metadata: { extraKey: "value", keep: "yes" } as JsonObject,
    });
    await wrapped.wrapModelCall?.(
      ctx,
      reqWithMeta,
      async () =>
        ({
          content: "ok",
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1 },
        }) as ModelResponse,
    );
    await wrapped.onAfterTurn?.(ctx);

    const meta = steps[0]?.metadata as JsonObject;
    const delta = meta.requestDelta as JsonObject;
    expect(delta).toBeDefined();
    const metaDelta = delta.metadata as JsonObject;
    expect(metaDelta).toBeDefined();
    const removed = metaDelta.removed as string[];
    expect(removed).toContain("extraKey");
  });

  test("records messages-changed delta when middleware adds a message", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const msgAdder: KoiMiddleware = {
      name: "msg-adder",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) =>
        next({
          ...request,
          messages: [
            ...request.messages,
            {
              senderId: "system",
              content: [{ kind: "text" as const, text: "injected" }],
              timestamp: 0,
            },
          ],
        }),
    };

    const wrapped = wrapMiddlewareWithTrace(msgAdder, config);
    const ctx = makeTurnCtx();
    await wrapped.wrapModelCall?.(
      ctx,
      makeModelRequest(),
      async () =>
        ({
          content: "ok",
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1 },
        }) as ModelResponse,
    );
    await wrapped.onAfterTurn?.(ctx);

    const meta = steps[0]?.metadata as JsonObject;
    const delta = meta.requestDelta as JsonObject;
    expect(delta).toBeDefined();
    const messages = delta.messages as JsonObject;
    expect(messages).toBeDefined();
    expect(messages.messagesBefore).toBe(1);
    expect(messages.messagesAfter).toBe(2);
  });

  test("records tools-changed delta when middleware adds a tool", async () => {
    const { steps, config } = createMockStoreWithDeltas();

    const toolAdder: KoiMiddleware = {
      name: "tool-adder",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) =>
        next({
          ...request,
          tools: [
            {
              name: "extra-tool",
              description: "test",
              inputSchema: { type: "object" as const, properties: {} },
            },
          ] as never,
        }),
    };

    const wrapped = wrapMiddlewareWithTrace(toolAdder, config);
    const ctx = makeTurnCtx();
    await wrapped.wrapModelCall?.(
      ctx,
      makeModelRequest(),
      async () =>
        ({
          content: "ok",
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1 },
        }) as ModelResponse,
    );
    await wrapped.onAfterTurn?.(ctx);

    const meta = steps[0]?.metadata as JsonObject;
    const delta = meta.requestDelta as JsonObject;
    expect(delta).toBeDefined();
    const tools = delta.tools as JsonObject;
    expect(tools).toBeDefined();
    const added = tools.added as string[];
    expect(added).toContain("extra-tool");
  });

  test("truncates request text longer than 500 chars", async () => {
    const { steps, config } = createMockStore();

    const mw: KoiMiddleware = {
      name: "long-text",
      describeCapabilities: () => undefined,
      wrapModelCall: async (_ctx, request, next) => next(request),
    };

    const wrapped = wrapMiddlewareWithTrace(mw, config);
    const longText = "a".repeat(600);
    const longRequest = makeModelRequest({
      messages: [{ senderId: "user", content: [{ kind: "text", text: longText }], timestamp: 0 }],
    });
    const ctx = makeTurnCtx();
    await wrapped.wrapModelCall?.(
      ctx,
      longRequest,
      async () =>
        ({
          content: "ok",
          model: "test",
          usage: { inputTokens: 1, outputTokens: 1 },
        }) as ModelResponse,
    );
    await wrapped.onAfterTurn?.(ctx);

    expect(steps.length).toBe(1);
    const reqText = steps[0]?.request?.text ?? "";
    // Truncated at 500 chars with ellipsis appended
    expect(reqText.endsWith("…")).toBe(true);
    expect(reqText.length).toBeLessThanOrEqual(502);
  });
});

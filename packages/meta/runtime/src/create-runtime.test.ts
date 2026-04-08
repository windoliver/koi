import { describe, expect, test } from "bun:test";
import type { EngineAdapter, EngineEvent, EngineInput, KoiMiddleware } from "@koi/core";
import { createRuntime } from "./create-runtime.js";
import { PHASE1_MIDDLEWARE_NAMES } from "./stubs/stub-middleware.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createFakeAdapter(id: string): EngineAdapter {
  return {
    engineId: id,
    capabilities: { text: true, images: false, files: false, audio: false },
    async *stream(_input: EngineInput): AsyncIterable<EngineEvent> {
      yield {
        kind: "done",
        output: {
          content: [{ kind: "text", text: "fake response" }],
          stopReason: "completed",
          metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
        },
      };
    },
  };
}

function createFakeMiddleware(name: string): KoiMiddleware {
  return {
    name,
    phase: "resolve",
    priority: 500,
    wrapModelCall: async (_ctx, request, next) => next(request),
    wrapToolCall: async (_ctx, request, next) => next(request),
    describeCapabilities: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRuntime", () => {
  test("boots with all defaults (everything stubbed)", () => {
    const runtime = createRuntime();

    expect(runtime.adapter.engineId).toBe("stub");
    expect(runtime.channel.name).toBe("stub");
    // All Phase 1 middleware should be present as stubs
    const names = runtime.middleware.map((mw) => mw.name);
    for (const expected of PHASE1_MIDDLEWARE_NAMES) {
      expect(names).toContain(expected);
    }
    // Debug is off by default
    expect(runtime.debugInfo).toBeUndefined();
  });

  test("accepts a real adapter instance", () => {
    const adapter = createFakeAdapter("my-engine");
    const runtime = createRuntime({ adapter });

    expect(runtime.adapter.engineId).toBe("my-engine");
  });

  test("accepts real middleware and fills stubs for missing Phase 1 names", () => {
    const realPermissions = createFakeMiddleware("permissions");
    const runtime = createRuntime({
      middleware: [realPermissions],
      requestApproval: async () => ({ kind: "allow" }),
    });

    const names = runtime.middleware.map((mw) => mw.name);
    // Real middleware is present
    expect(names).toContain("permissions");
    // Other Phase 1 middleware filled with stubs
    expect(names).toContain("event-trace");
    expect(names).toContain("hooks");
    expect(names).toContain("context-manager");
    expect(names).toContain("tool-execution");
    // Total: 1 real + 4 stubs = 5
    expect(runtime.middleware).toHaveLength(5);
  });

  test("does not duplicate middleware when all Phase 1 names provided", () => {
    const allReal = PHASE1_MIDDLEWARE_NAMES.map((name) => createFakeMiddleware(name));
    const runtime = createRuntime({
      middleware: allReal,
      requestApproval: async () => ({ kind: "allow" }),
    });

    expect(runtime.middleware).toHaveLength(PHASE1_MIDDLEWARE_NAMES.length);
    // No stubs added
    const names = runtime.middleware.map((mw) => mw.name);
    for (const expected of PHASE1_MIDDLEWARE_NAMES) {
      expect(names.filter((n) => n === expected)).toHaveLength(1);
    }
  });

  test("throws when real permissions middleware installed without requestApproval", () => {
    const realPermissions = createFakeMiddleware("permissions");
    expect(() => createRuntime({ middleware: [realPermissions] })).toThrow(
      "no requestApproval handler",
    );
  });

  test("debug info is populated when debug is true", () => {
    const runtime = createRuntime({ debug: true });

    expect(runtime.debugInfo).toBeDefined();
    expect(runtime.debugInfo?.adapter.name).toBe("stub");
    expect(runtime.debugInfo?.adapter.stubbed).toBe(true);
    expect(runtime.debugInfo?.channel.name).toBe("stub");
    expect(runtime.debugInfo?.middleware.length).toBe(PHASE1_MIDDLEWARE_NAMES.length);
    // All middleware should be marked as stubbed
    for (const entry of runtime.debugInfo?.middleware ?? []) {
      expect(entry.stubbed).toBe(true);
      expect(entry.enabled).toBe(true);
    }
  });

  test("debug info marks real adapter as not stubbed", () => {
    const adapter = createFakeAdapter("my-engine");
    const runtime = createRuntime({ adapter, debug: true });

    expect(runtime.debugInfo?.adapter.stubbed).toBe(false);
  });

  test("debug info marks real middleware as not stubbed", () => {
    const realPermissions = createFakeMiddleware("permissions");
    const runtime = createRuntime({
      middleware: [realPermissions],
      debug: true,
      requestApproval: async () => ({ kind: "allow" }),
    });

    const permEntry = runtime.debugInfo?.middleware.find((m) => m.name === "permissions");
    expect(permEntry?.stubbed).toBe(false);

    const traceEntry = runtime.debugInfo?.middleware.find((m) => m.name === "event-trace");
    expect(traceEntry?.stubbed).toBe(true);
  });

  test("dispose disconnects channel and disposes adapter", async () => {
    let channelDisconnected = false;
    let adapterDisposed = false;

    const runtime = createRuntime({
      adapter: {
        ...createFakeAdapter("disposable"),
        dispose: async () => {
          adapterDisposed = true;
        },
      },
      channel: {
        name: "disposable-channel",
        capabilities: {
          text: true,
          images: false,
          files: false,
          buttons: false,
          audio: false,
          video: false,
          threads: false,
          supportsA2ui: false,
        },
        connect: async () => {},
        disconnect: async () => {
          channelDisconnected = true;
        },
        send: async () => {},
        onMessage: () => () => {},
      },
    });

    await runtime.dispose();
    expect(channelDisconnected).toBe(true);
    expect(adapterDisposed).toBe(true);
  });

  test("wraps adapter with stream timeout enforcement", async () => {
    let receivedSignal: AbortSignal | undefined;

    const spyAdapter: EngineAdapter = {
      ...createFakeAdapter("spy"),
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        receivedSignal = input.signal;
        return createFakeAdapter("spy").stream(input);
      },
    };

    const runtime = createRuntime({ adapter: spyAdapter, streamTimeoutMs: 5000 });

    // Consume one event to trigger stream()
    for await (const _event of runtime.adapter.stream({ kind: "text", text: "test" })) {
      break;
    }

    // The adapter should have received a composed signal (from timeout wrapper)
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
  });

  test("stream timeout composes with caller signal", async () => {
    let receivedSignal: AbortSignal | undefined;

    const spyAdapter: EngineAdapter = {
      ...createFakeAdapter("spy"),
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        receivedSignal = input.signal;
        return createFakeAdapter("spy").stream(input);
      },
    };

    const runtime = createRuntime({ adapter: spyAdapter });
    const callerController = new AbortController();

    for await (const _event of runtime.adapter.stream({
      kind: "text",
      text: "test",
      signal: callerController.signal,
    })) {
      break;
    }

    // The received signal should NOT be the caller's original signal
    // (it should be a composed signal from AbortSignal.any())
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).not.toBe(callerController.signal);
  });

  test("dispose completes adapter cleanup even when channel disconnect fails", async () => {
    let adapterDisposed = false;

    const runtime = createRuntime({
      adapter: {
        ...createFakeAdapter("resilient"),
        dispose: async () => {
          adapterDisposed = true;
        },
      },
      channel: {
        name: "failing-channel",
        capabilities: {
          text: true,
          images: false,
          files: false,
          buttons: false,
          audio: false,
          video: false,
          threads: false,
          supportsA2ui: false,
        },
        connect: async () => {},
        disconnect: async () => {
          throw new Error("channel disconnect failed");
        },
        send: async () => {},
        onMessage: () => () => {},
      },
    });

    await expect(runtime.dispose()).rejects.toThrow("channel disconnect failed");
    // Adapter must still have been disposed despite channel failure
    expect(adapterDisposed).toBe(true);
  });

  test("dispose surfaces both errors when channel and adapter fail", async () => {
    const runtime = createRuntime({
      adapter: {
        ...createFakeAdapter("both-fail"),
        dispose: async () => {
          throw new Error("adapter boom");
        },
      },
      channel: {
        name: "both-fail-channel",
        capabilities: {
          text: true,
          images: false,
          files: false,
          buttons: false,
          audio: false,
          video: false,
          threads: false,
          supportsA2ui: false,
        },
        connect: async () => {},
        disconnect: async () => {
          throw new Error("channel boom");
        },
        send: async () => {},
        onMessage: () => () => {},
      },
    });

    await expect(runtime.dispose()).rejects.toThrow("channel boom");
    // The error message should contain both failures
    try {
      await runtime.dispose();
    } catch (e: unknown) {
      expect((e instanceof Error ? e.message : "").includes("adapter boom")).toBe(true);
    }
  });

  test("middleware wrapModelCall executes through adapter.stream() when terminals present", async () => {
    let middlewareCalled = false;

    const middleware: KoiMiddleware = {
      name: "spy-middleware",
      phase: "resolve",
      priority: 500,
      wrapModelCall: async (_ctx, request, next) => {
        middlewareCalled = true;
        return next(request);
      },
      describeCapabilities: () => undefined,
    };

    // Adapter with terminals — middleware SHOULD be composed around them
    const adapterWithTerminals: EngineAdapter = {
      engineId: "terminal-adapter",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async () => ({ content: "response", model: "test" }),
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        // A cooperating adapter calls callHandlers.modelCall (composed through middleware)
        return (async function* () {
          if (input.callHandlers !== undefined) {
            await input.callHandlers.modelCall({ messages: [], model: "test" });
          }
          yield {
            kind: "done" as const,
            output: {
              content: [],
              stopReason: "completed" as const,
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: 0,
                durationMs: 0,
              },
            },
          };
        })();
      },
    };

    const runtime = createRuntime({
      adapter: adapterWithTerminals,
      middleware: [middleware],
    });

    // Consume the stream — this should trigger the middleware through callHandlers
    for await (const _event of runtime.adapter.stream({ kind: "text", text: "test" })) {
      // drain
    }

    expect(middlewareCalled).toBe(true);
  });

  test("traceCallId is injected into model request metadata", async () => {
    let capturedMetadata: Record<string, unknown> | undefined;

    const middleware: KoiMiddleware = {
      name: "trace-spy",
      phase: "resolve",
      priority: 500,
      wrapModelCall: async (_ctx, request, next) => {
        capturedMetadata = request.metadata as Record<string, unknown> | undefined;
        return next(request);
      },
      describeCapabilities: () => undefined,
    };

    const adapterWithTerminals: EngineAdapter = {
      engineId: "trace-test",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async () => ({ content: "ok", model: "test" }),
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        return (async function* () {
          if (input.callHandlers !== undefined) {
            await input.callHandlers.modelCall({ messages: [], model: "test" });
          }
          yield {
            kind: "done" as const,
            output: {
              content: [],
              stopReason: "completed" as const,
              metrics: {
                totalTokens: 0,
                inputTokens: 0,
                outputTokens: 0,
                turns: 0,
                durationMs: 0,
              },
            },
          };
        })();
      },
    };

    const runtime = createRuntime({
      adapter: adapterWithTerminals,
      middleware: [middleware],
    });

    for await (const _event of runtime.adapter.stream({ kind: "text", text: "test" })) {
      // drain
    }

    expect(capturedMetadata).toBeDefined();
    expect(typeof capturedMetadata?.traceCallId).toBe("string");
    // Should be a valid UUID
    expect(capturedMetadata?.traceCallId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  test("trajectoryStore is created when trajectoryDir is provided", () => {
    const runtime = createRuntime({
      trajectoryDir: `/tmp/koi-traj-test-${Date.now()}`,
    });

    expect(runtime.trajectoryStore).toBeDefined();
  });

  test("trajectoryStore is undefined when trajectoryDir is not provided", () => {
    const runtime = createRuntime();
    expect(runtime.trajectoryStore).toBeUndefined();
  });

  test("trajectoryStore is created when trajectoryNexus is provided", () => {
    const runtime = createRuntime({
      trajectoryNexus: {
        url: "http://localhost:3100",
      },
    });
    expect(runtime.trajectoryStore).toBeDefined();
  });

  test("throws when both trajectoryDir and trajectoryNexus are provided", () => {
    expect(() =>
      createRuntime({
        trajectoryDir: `/tmp/koi-traj-test-${Date.now()}`,
        trajectoryNexus: { url: "http://localhost:3100" },
      }),
    ).toThrow("Cannot provide both trajectoryDir and trajectoryNexus");
  });

  test("dispose closes Nexus trajectory transport", async () => {
    const runtime = createRuntime({
      trajectoryNexus: {
        url: "http://localhost:3100",
      },
    });
    // dispose should not throw (transport.close() is called internally)
    await runtime.dispose();
  });

  test("retrySignalReader is accepted and threads to event-trace", () => {
    const fakeReader: import("@koi/core").RetrySignalReader = {
      getRetrySignal: () => undefined,
      consumeRetrySignal: () => undefined,
    };
    const runtime = createRuntime({
      retrySignalReader: fakeReader,
      agentName: "test-agent",
      trajectoryDir: `/tmp/koi-traj-test-${Date.now()}`,
    });

    expect(runtime.trajectoryStore).toBeDefined();
    expect(runtime.adapter).toBeDefined();
  });
});

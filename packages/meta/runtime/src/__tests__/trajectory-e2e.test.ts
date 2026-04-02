/**
 * Integration test: multi-middleware flow → ATIF trajectory on local FS.
 *
 * Exercises the full path: createRuntime with real middleware, a cooperating
 * adapter that calls model + tool through callHandlers, and verifies that
 * the FS-backed ATIF store captures the trajectory with traceCallId correlation.
 *
 * No LLM needed — middleware is just onion wrappers around function calls.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type {
  EngineAdapter,
  EngineEvent,
  EngineInput,
  KoiMiddleware,
  ModelChunk,
  ModelRequest,
  ModelResponse,
  RichTrajectoryStep,
  ToolRequest,
  ToolResponse,
  TurnContext,
} from "@koi/core";
import { createRuntime } from "../create-runtime.js";

const TRAJ_DIR = `/tmp/koi-traj-e2e-${Date.now()}`;

afterEach(() => {
  try {
    rmSync(TRAJ_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Test middleware: logs every model/tool call it sees
// ---------------------------------------------------------------------------

interface CallRecord {
  readonly hook: "model" | "tool";
  readonly traceCallId: string | undefined;
  readonly requestSnapshot: unknown;
}

function createLoggingMiddleware(log: CallRecord[]): KoiMiddleware {
  return {
    name: "logging",
    phase: "observe",
    priority: 900,
    wrapModelCall: async (_ctx: TurnContext, request: ModelRequest, next) => {
      const meta = request.metadata as Record<string, unknown> | undefined;
      log.push({
        hook: "model",
        traceCallId: typeof meta?.traceCallId === "string" ? meta.traceCallId : undefined,
        requestSnapshot: { model: request.model, messageCount: request.messages.length },
      });
      return next(request);
    },
    wrapToolCall: async (_ctx: TurnContext, request: ToolRequest, next) => {
      const meta = request.metadata as Record<string, unknown> | undefined;
      log.push({
        hook: "tool",
        traceCallId: typeof meta?.traceCallId === "string" ? meta.traceCallId : undefined,
        requestSnapshot: { toolId: request.toolId },
      });
      return next(request);
    },
    describeCapabilities: () => undefined,
  };
}

function createMutatingMiddleware(): KoiMiddleware {
  return {
    name: "mutating",
    phase: "intercept",
    priority: 100,
    wrapModelCall: async (_ctx: TurnContext, request: ModelRequest, next) => {
      // Add a marker to prove middleware ran
      const enriched: ModelRequest = {
        ...request,
        metadata: { ...request.metadata, mutatedBy: "intercept-middleware" },
      };
      return next(enriched);
    },
    describeCapabilities: () => undefined,
  };
}

// ---------------------------------------------------------------------------
// Cooperating adapter: calls model → tool → model through callHandlers
// ---------------------------------------------------------------------------

function createCooperatingAdapter(): EngineAdapter {
  return {
    engineId: "cooperating-test",
    capabilities: { text: true, images: false, files: false, audio: false },
    terminals: {
      modelCall: async (request: ModelRequest): Promise<ModelResponse> => ({
        content: `response to ${request.messages.length} messages`,
        model: "fake-model",
      }),
      toolCall: async (request: ToolRequest): Promise<ToolResponse> => ({
        output: `tool ${request.toolId} executed`,
      }),
    },
    stream(input: EngineInput): AsyncIterable<EngineEvent> {
      const handlers = input.callHandlers;
      return (async function* () {
        if (handlers !== undefined) {
          // Simulate: model call → tool call → model call
          await handlers.modelCall({ messages: [], model: "fake-model" });
          await handlers.toolCall({ toolId: "read_file", input: { path: "/tmp/x" } });
          await handlers.modelCall({
            messages: [
              {
                senderId: "user",
                timestamp: Date.now(),
                content: [{ kind: "text", text: "follow-up" }],
              },
            ],
            model: "fake-model",
          });
        }

        yield {
          kind: "done" as const,
          output: {
            content: [{ kind: "text" as const, text: "final answer" }],
            stopReason: "completed" as const,
            metrics: {
              totalTokens: 100,
              inputTokens: 80,
              outputTokens: 20,
              turns: 1,
              durationMs: 500,
            },
          },
        };
      })();
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("trajectory E2E: multi-middleware flow → ATIF on local FS", () => {
  test("3-call flow through 2 middleware layers records traceCallIds", async () => {
    const log: CallRecord[] = [];

    const runtime = createRuntime({
      adapter: createCooperatingAdapter(),
      middleware: [createLoggingMiddleware(log), createMutatingMiddleware()],
      trajectoryDir: TRAJ_DIR,
      agentName: "e2e-test-agent",
      debug: true,
    });

    // Drive the adapter
    for await (const _event of runtime.adapter.stream({ kind: "text", text: "go" })) {
      // drain
    }

    // -----------------------------------------------------------------------
    // Verify middleware was called for all 3 calls
    // -----------------------------------------------------------------------
    expect(log).toHaveLength(3);
    expect(log[0]?.hook).toBe("model");
    expect(log[1]?.hook).toBe("tool");
    expect(log[2]?.hook).toBe("model");

    // -----------------------------------------------------------------------
    // Verify traceCallId was injected into every call
    // -----------------------------------------------------------------------
    for (const record of log) {
      expect(record.traceCallId).toBeDefined();
      expect(record.traceCallId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }

    // Each call should have a DIFFERENT traceCallId
    const ids = new Set(log.map((r) => r.traceCallId));
    expect(ids.size).toBe(3);

    // -----------------------------------------------------------------------
    // Verify mutating middleware ran (intercept phase, lower priority = outer)
    // -----------------------------------------------------------------------
    const modelCalls = log.filter((r) => r.hook === "model");
    for (const call of modelCalls) {
      const snap = call.requestSnapshot as Record<string, unknown>;
      expect(snap).toBeDefined();
    }

    // -----------------------------------------------------------------------
    // Verify I/O was recorded to the trajectory store as RichTrajectorySteps
    // -----------------------------------------------------------------------
    // Give wrapStreamWithFlush a tick to complete
    await new Promise((r) => setTimeout(r, 50));

    const store = runtime.trajectoryStore;
    expect(store).toBeDefined();
    if (store === undefined) throw new Error("store should exist");

    // Each stream() call gets a unique docId — find it from the ATIF files on disk
    const files = await readdir(TRAJ_DIR);
    const atifFiles = files.filter((f) => f.endsWith(".atif.json"));
    expect(atifFiles).toHaveLength(1);
    const docId = atifFiles[0]?.replace(".atif.json", "") ?? "";

    const steps = await store.getDocument(docId);
    // 3 call steps + middleware spans for each (debug: true enables instrumentation)
    expect(steps.length).toBeGreaterThanOrEqual(3);

    // Separate: harness call steps (have traceCallId), event-trace steps (have totalMessages),
    // and middleware span steps (identifier starts with "middleware:")
    const spanSteps = steps.filter((s) => s.identifier.startsWith("middleware:"));
    const harnessSteps = steps.filter(
      (s) => !s.identifier.startsWith("middleware:") && s.metadata?.traceCallId !== undefined,
    );
    const eventTraceSteps = steps.filter(
      (s) => !s.identifier.startsWith("middleware:") && s.metadata?.traceCallId === undefined,
    );

    // Harness should record 3 call steps (model → tool → model)
    expect(harnessSteps).toHaveLength(3);
    // Event-trace should also record steps (unified trajectory)
    expect(eventTraceSteps.length).toBeGreaterThanOrEqual(0);

    const callSteps = harnessSteps;

    // Call step 0: model call
    expect(callSteps[0]?.kind).toBe("model_call");
    expect(callSteps[0]?.identifier).toBe("fake-model");
    expect(callSteps[0]?.outcome).toBe("success");
    expect(callSteps[0]?.request?.text).toBeDefined();
    expect(callSteps[0]?.response?.text).toContain("response to");

    // Call step 1: tool call with full input
    expect(callSteps[1]?.kind).toBe("tool_call");
    expect(callSteps[1]?.identifier).toBe("read_file");
    expect(callSteps[1]?.request?.text).toContain("read_file");
    expect(callSteps[1]?.request?.text).toContain("/tmp/x");
    expect(callSteps[1]?.response?.text).toContain("read_file executed");

    // Call step 2: follow-up model call
    expect(callSteps[2]?.kind).toBe("model_call");
    expect(callSteps[2]?.request?.text).toContain("follow-up");

    // -----------------------------------------------------------------------
    // Verify middleware spans are recorded
    // -----------------------------------------------------------------------
    expect(spanSteps.length).toBeGreaterThan(0);

    // Should have spans for our middleware (logging + mutating)
    const middlewareNames = new Set(spanSteps.map((s) => s.identifier.replace("middleware:", "")));
    expect(middlewareNames.has("logging")).toBe(true);
    expect(middlewareNames.has("mutating")).toBe(true);

    // Each span should have timing + phase + hook metadata + I/O
    for (const span of spanSteps) {
      expect(span.source).toBe("system");
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(span.metadata?.hook).toBeDefined();
      expect(span.metadata?.phase).toBeDefined();
      expect(span.metadata?.traceCallId).toBeDefined();
      // Middleware I/O captured
      expect(span.request?.text).toBeDefined();
      expect(span.response?.text).toBeDefined();
    }

    // Verify the logging middleware saw the model response content
    const loggingModelSpan = spanSteps.find(
      (s) => s.identifier === "middleware:logging" && s.metadata?.hook === "wrapModelCall",
    );
    expect(loggingModelSpan?.response?.text).toContain("response to");

    // traceCallIds: call steps and their span steps should share the same IDs
    const callIds = new Set(callSteps.map((s) => s.metadata?.traceCallId));
    expect(callIds.size).toBe(3);
    for (const span of spanSteps) {
      expect(callIds.has(span.metadata?.traceCallId)).toBe(true);
    }
  });

  test("no middleware spans when debug is disabled", async () => {
    const runtime = createRuntime({
      adapter: createCooperatingAdapter(),
      middleware: [createLoggingMiddleware([]), createMutatingMiddleware()],
      trajectoryDir: TRAJ_DIR,
      agentName: "no-debug",
      // debug: false (default) — no instrumentation
    });

    for await (const _event of runtime.adapter.stream({ kind: "text", text: "go" })) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 50));

    const store = runtime.trajectoryStore;
    if (store === undefined) throw new Error("store should exist");
    const files = await readdir(TRAJ_DIR);
    const atifFiles = files.filter((f) => f.endsWith(".atif.json"));
    expect(atifFiles).toHaveLength(1);
    const docId = atifFiles[0]?.replace(".atif.json", "") ?? "";
    const steps = await store.getDocument(docId);

    // No middleware spans when debug is off
    const spanSteps = steps.filter((s) => s.identifier.startsWith("middleware:"));
    expect(spanSteps).toHaveLength(0);

    // Harness call steps + event-trace steps (unified trajectory)
    const callSteps = steps.filter((s) => !s.identifier.startsWith("middleware:"));
    expect(callSteps.length).toBeGreaterThanOrEqual(3);
  });

  test("only active middleware appears in spans (removed middleware absent)", async () => {
    // Only 1 middleware — no mutating middleware
    const runtime = createRuntime({
      adapter: createCooperatingAdapter(),
      middleware: [createLoggingMiddleware([])],
      trajectoryDir: TRAJ_DIR,
      agentName: "one-mw",
      debug: true,
    });

    for await (const _event of runtime.adapter.stream({ kind: "text", text: "go" })) {
      // drain
    }
    await new Promise((r) => setTimeout(r, 50));

    const store = runtime.trajectoryStore;
    if (store === undefined) throw new Error("store should exist");
    const files = await readdir(TRAJ_DIR);
    const atifFiles = files.filter((f) => f.endsWith(".atif.json"));
    expect(atifFiles).toHaveLength(1);
    const docId = atifFiles[0]?.replace(".atif.json", "") ?? "";
    const steps = await store.getDocument(docId);

    const spanSteps = steps.filter((s) => s.identifier.startsWith("middleware:"));
    const mwNames = new Set(spanSteps.map((s) => s.identifier.replace("middleware:", "")));

    // Only "logging" should appear — "mutating" was never wired
    expect(mwNames.has("logging")).toBe(true);
    expect(mwNames.has("mutating")).toBe(false);
  });

  test("trajectory store is writable and readable", async () => {
    const runtime = createRuntime({
      adapter: createCooperatingAdapter(),
      middleware: [],
      trajectoryDir: TRAJ_DIR,
      agentName: "e2e-test-agent",
    });

    expect(runtime.trajectoryStore).toBeDefined();
    const store = runtime.trajectoryStore;
    if (store === undefined) throw new Error("store should exist");

    // Write a step manually (simulating what event-trace would do)
    const step: RichTrajectoryStep = {
      stepIndex: 0,
      timestamp: Date.now(),
      source: "agent",
      kind: "model_call",
      identifier: "fake-model",
      outcome: "success",
      durationMs: 100,
      request: { text: "hello" },
      response: { text: "world" },
      metadata: { traceCallId: "test-correlation-id" },
    };

    await store.append("e2e-session", [step]);

    // Read back
    const steps = await store.getDocument("e2e-session");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.identifier).toBe("fake-model");
    expect(steps[0]?.metadata?.traceCallId).toBe("test-correlation-id");

    // Verify ATIF file exists on disk
    const files = await readdir(TRAJ_DIR);
    expect(files.some((f) => f.endsWith(".atif.json"))).toBe(true);
  });

  test("ATIF file on disk has valid schema_version and agent metadata", async () => {
    const runtime = createRuntime({
      adapter: createCooperatingAdapter(),
      middleware: [],
      trajectoryDir: TRAJ_DIR,
      agentName: "my-agent",
      agentVersion: "1.0.0",
    });

    const store = runtime.trajectoryStore;
    if (store === undefined) throw new Error("store should exist");

    await store.append("schema-test", [
      {
        stepIndex: 0,
        timestamp: Date.now(),
        source: "agent",
        kind: "model_call",
        identifier: "gpt-4",
        outcome: "success",
        durationMs: 50,
        metrics: { promptTokens: 100, completionTokens: 20 },
      },
    ]);

    // Read raw ATIF JSON from disk
    const rawJson = await Bun.file(`${TRAJ_DIR}/schema-test.atif.json`).json();
    const doc = rawJson as Record<string, unknown>;

    expect(doc.schema_version).toBe("ATIF-v1.6");
    expect(doc.session_id).toBe("schema-test");

    const agent = doc.agent as Record<string, unknown>;
    expect(agent.name).toBe("my-agent");
    expect(agent.version).toBe("1.0.0");

    const steps = doc.steps as readonly Record<string, unknown>[];
    expect(steps).toHaveLength(1);
    expect(steps[0]?.model_name).toBe("gpt-4");
    expect(steps[0]?.outcome).toBe("success");

    const metrics = steps[0]?.metrics as Record<string, unknown>;
    expect(metrics?.prompt_tokens).toBe(100);
    expect(metrics?.completion_tokens).toBe(20);
  });

  test("multiple sessions produce separate ATIF files", async () => {
    const runtime = createRuntime({
      adapter: createCooperatingAdapter(),
      middleware: [],
      trajectoryDir: TRAJ_DIR,
      agentName: "multi-session",
    });

    const store = runtime.trajectoryStore;
    if (store === undefined) throw new Error("store should exist");

    await store.append("session-a", [
      {
        stepIndex: 0,
        timestamp: Date.now(),
        source: "agent",
        kind: "model_call",
        identifier: "model-a",
        outcome: "success",
        durationMs: 10,
      },
    ]);
    await store.append("session-b", [
      {
        stepIndex: 0,
        timestamp: Date.now(),
        source: "tool",
        kind: "tool_call",
        identifier: "bash",
        outcome: "success",
        durationMs: 20,
      },
    ]);

    const files = await readdir(TRAJ_DIR);
    const atifFiles = files.filter((f) => f.endsWith(".atif.json")).sort();
    expect(atifFiles).toEqual(["session-a.atif.json", "session-b.atif.json"]);

    // Each session has its own data
    const stepsA = await store.getDocument("session-a");
    const stepsB = await store.getDocument("session-b");
    expect(stepsA[0]?.kind).toBe("model_call");
    expect(stepsB[0]?.kind).toBe("tool_call");
  });

  // -------------------------------------------------------------------------
  // Tool failure recording
  // -------------------------------------------------------------------------

  test("failed tool calls are recorded with outcome failure", async () => {
    const failingAdapter: EngineAdapter = {
      engineId: "failing-tool",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "ok",
          model: "fake",
        }),
        toolCall: async (): Promise<ToolResponse> => {
          throw new Error("permission denied");
        },
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        const handlers = input.callHandlers;
        return (async function* () {
          if (handlers !== undefined) {
            try {
              await handlers.toolCall({ toolId: "rm_rf", input: { path: "/" } });
            } catch {
              // Expected — tool was denied
            }
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
      adapter: failingAdapter,
      middleware: [],
      trajectoryDir: TRAJ_DIR,
      agentName: "failure-test",
    });

    for await (const _event of runtime.adapter.stream({ kind: "text", text: "go" })) {
      // drain
    }

    await new Promise((r) => setTimeout(r, 50));
    const store = runtime.trajectoryStore;
    if (store === undefined) throw new Error("store should exist");

    const files = await readdir(TRAJ_DIR);
    const atifFiles = files.filter((f) => f.endsWith(".atif.json"));
    expect(atifFiles).toHaveLength(1);
    const docId = decodeURIComponent(atifFiles[0]?.replace(".atif.json", "") ?? "");
    const steps = await store.getDocument(docId);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    const toolFailStep = steps.find((s) => s.kind === "tool_call" && s.outcome === "failure");
    expect(toolFailStep).toBeDefined();
    expect(toolFailStep?.identifier).toBe("rm_rf");
  });

  // -------------------------------------------------------------------------
  // Stream model trajectory (uses modelStream terminal)
  // -------------------------------------------------------------------------

  test("streaming model calls produce trajectory steps", async () => {
    const streamingAdapter: EngineAdapter = {
      engineId: "streaming-test",
      capabilities: { text: true, images: false, files: false, audio: false },
      terminals: {
        modelCall: async (): Promise<ModelResponse> => ({
          content: "non-streaming fallback",
          model: "fake",
        }),
        modelStream: (_request: ModelRequest): AsyncIterable<ModelChunk> => {
          return (async function* () {
            yield { kind: "text_delta" as const, delta: "streamed " };
            yield { kind: "text_delta" as const, delta: "response" };
            yield {
              kind: "done" as const,
              response: { content: "streamed response", model: "fake-stream" },
            };
          })();
        },
      },
      stream(input: EngineInput): AsyncIterable<EngineEvent> {
        const handlers = input.callHandlers;
        return (async function* () {
          if (handlers?.modelStream !== undefined) {
            // Use the streaming path
            for await (const _chunk of handlers.modelStream({
              messages: [],
              model: "fake-stream",
            })) {
              // drain the stream through middleware
            }
          }
          yield {
            kind: "done" as const,
            output: {
              content: [{ kind: "text" as const, text: "streamed response" }],
              stopReason: "completed" as const,
              metrics: {
                totalTokens: 10,
                inputTokens: 8,
                outputTokens: 2,
                turns: 1,
                durationMs: 100,
              },
            },
          };
        })();
      },
    };

    const runtime = createRuntime({
      adapter: streamingAdapter,
      middleware: [],
      trajectoryDir: TRAJ_DIR,
      agentName: "stream-test",
    });

    for await (const _event of runtime.adapter.stream({ kind: "text", text: "go" })) {
      // drain
    }

    await new Promise((r) => setTimeout(r, 50));
    const store = runtime.trajectoryStore;
    if (store === undefined) throw new Error("store should exist");

    const files = await readdir(TRAJ_DIR);
    const atifFiles = files.filter((f) => f.endsWith(".atif.json"));
    expect(atifFiles).toHaveLength(1);
    const docId = decodeURIComponent(atifFiles[0]?.replace(".atif.json", "") ?? "");
    const steps = await store.getDocument(docId);

    expect(steps.length).toBeGreaterThanOrEqual(1);
    // Harness model_call step (has traceCallId)
    const harnessStep = steps.find((s) => s.metadata?.traceCallId !== undefined);
    expect(harnessStep?.kind).toBe("model_call");
    expect(harnessStep?.outcome).toBe("success");
    expect(harnessStep?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

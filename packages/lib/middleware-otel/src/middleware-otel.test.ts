/**
 * Integration tests for createOtelMiddleware.
 *
 * Uses InMemorySpanExporter + SimpleSpanProcessor (synchronous) for tests.
 * Production deployments must use BatchSpanProcessor — it never blocks the request path.
 *
 * Coverage (per review decisions):
 *   Issue 9A  — No OTel provider: graceful no-op, no throw
 *   Issue 10A — Span name, parent ID, status code, required attribute assertions
 *   Issue 11A — captureContent: false → no span events (negative assertion)
 *   Issue 12A — Throwing exporter: agent turn unaffected, observer-never-throws
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { RichTrajectoryStep } from "@koi/core/rich-trajectory";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { createOtelMiddleware } from "./middleware-otel.js";
import {
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  ATTR_KOI_SESSION_ID,
  ATTR_KOI_STEP_OUTCOME,
  EVENT_GEN_AI_CHOICE,
  EVENT_GEN_AI_USER_MESSAGE,
  GEN_AI_OPERATION_CHAT,
  GEN_AI_OPERATION_EXECUTE_TOOL,
  GEN_AI_OPERATION_INVOKE_AGENT,
} from "./semconv.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION_ID = "sess-test-001";
const AGENT_ID = "test-agent";

function makeModelStep(overrides?: Partial<RichTrajectoryStep>): RichTrajectoryStep {
  return {
    stepIndex: 0,
    timestamp: 1_000,
    source: "agent",
    kind: "model_call",
    identifier: "gpt-4o",
    outcome: "success",
    durationMs: 500,
    metrics: { promptTokens: 100, completionTokens: 200 },
    metadata: { requestModel: "gpt-4o", responseModel: "gpt-4o-2024-11-20" },
    request: { text: "Hello, world!" },
    response: { text: "Hi there!" },
    ...overrides,
  };
}

function makeToolStep(overrides?: Partial<RichTrajectoryStep>): RichTrajectoryStep {
  return {
    stepIndex: 1,
    timestamp: 2_000,
    source: "tool",
    kind: "tool_call",
    identifier: "add_numbers",
    outcome: "success",
    durationMs: 50,
    ...overrides,
  };
}

/** Fake SessionContext-like object for lifecycle hooks. */
function makeSessionCtx(sessionId = SESSION_ID, agentId = AGENT_ID) {
  return { sessionId, agentId, runId: "run-1", metadata: {} } as const;
}

// ---------------------------------------------------------------------------
// OTel provider setup/teardown
// ---------------------------------------------------------------------------

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

function setupProvider(): void {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    // SimpleSpanProcessor is synchronous — correct for tests.
    // Production must use BatchSpanProcessor to avoid blocking the request path.
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
}

function teardownProvider(): void {
  trace.disable();
  exporter.reset();
}

/** Get the parent span ID from a ReadableSpan (SDK v2 uses parentSpanContext). */
function parentSpanId(span: ReadableSpan): string | undefined {
  return span.parentSpanContext?.spanId;
}

// ---------------------------------------------------------------------------
// Issue 9A: No-provider graceful degradation
// ---------------------------------------------------------------------------

describe("no OTel provider registered", () => {
  test("onStep does not throw when no provider is configured", () => {
    // Explicitly disable any registered provider
    trace.disable();

    const otel = createOtelMiddleware();
    const ctx = makeSessionCtx();

    // No throw — no-op tracer handles everything silently
    expect(async () => {
      await otel.middleware.onSessionStart?.(ctx as never);
      otel.onStep(SESSION_ID, makeModelStep());
      otel.onStep(SESSION_ID, makeToolStep());
      await otel.middleware.onSessionEnd?.(ctx as never);
    }).not.toThrow();
  });

  test("onStep does not throw for unknown session ID", () => {
    trace.disable();
    const otel = createOtelMiddleware();

    // No session state — should silently skip
    expect(() => {
      otel.onStep("non-existent-session", makeModelStep());
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Issue 10A: Span name, parent, status, required attributes
// ---------------------------------------------------------------------------

describe("with OTel provider registered", () => {
  beforeEach(setupProvider);
  afterEach(teardownProvider);

  describe("session span", () => {
    test("creates root span with correct name and attributes", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();

      await otel.middleware.onSessionStart?.(ctx as never);
      await otel.middleware.onSessionEnd?.(ctx as never);

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const [sessionSpan] = spans;
      if (sessionSpan === undefined) throw new Error("sessionSpan should be defined");
      expect(sessionSpan.name).toBe(`${GEN_AI_OPERATION_INVOKE_AGENT} ${AGENT_ID}`);
      expect(sessionSpan.attributes[ATTR_KOI_SESSION_ID]).toBe(SESSION_ID);
      expect(sessionSpan.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe(
        GEN_AI_OPERATION_INVOKE_AGENT,
      );
    });
  });

  describe("model call span", () => {
    test("emits span with correct name", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      expect(modelSpan.name).toBe("chat gpt-4o");
    });

    test("includes required gen_ai attributes", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      expect(modelSpan.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe(GEN_AI_OPERATION_CHAT);
      expect(modelSpan.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe("openai");
      expect(modelSpan.attributes[ATTR_KOI_SESSION_ID]).toBe(SESSION_ID);
      expect(modelSpan.attributes[ATTR_KOI_STEP_OUTCOME]).toBe("success");
    });

    test("includes token usage attributes", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      expect(modelSpan.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
      expect(modelSpan.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(200);
    });

    test("model span is child of session span", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const spans = exporter.getFinishedSpans();
      const sessionSpan = spans.find((s) => s.name.startsWith(GEN_AI_OPERATION_INVOKE_AGENT));
      const modelSpan = spans.find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));

      if (sessionSpan === undefined) throw new Error("sessionSpan should be defined");
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      expect(parentSpanId(modelSpan)).toBe(sessionSpan.spanContext().spanId);
    });

    test("sets ERROR status on failure outcome", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep({ outcome: "failure" }));
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      expect(modelSpan.status.code).toBe(SpanStatusCode.ERROR);
    });

    test("sets UNSET status on success outcome", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep({ outcome: "success" }));
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      expect(modelSpan.status.code).toBe(SpanStatusCode.UNSET);
    });
  });

  describe("tool call span", () => {
    test("emits span with correct name", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep());
      otel.onStep(SESSION_ID, makeToolStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const toolSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_EXECUTE_TOOL));
      if (toolSpan === undefined) throw new Error("toolSpan should be defined");
      expect(toolSpan.name).toBe("execute_tool add_numbers");
    });

    test("includes required tool attributes", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeToolStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const toolSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_EXECUTE_TOOL));
      if (toolSpan === undefined) throw new Error("toolSpan should be defined");
      expect(toolSpan.attributes[ATTR_GEN_AI_OPERATION_NAME]).toBe(GEN_AI_OPERATION_EXECUTE_TOOL);
      expect(toolSpan.attributes[ATTR_GEN_AI_TOOL_NAME]).toBe("add_numbers");
      expect(toolSpan.attributes[ATTR_KOI_SESSION_ID]).toBe(SESSION_ID);
    });

    test("tool span is child of last model span", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep());
      otel.onStep(SESSION_ID, makeToolStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const spans = exporter.getFinishedSpans();
      const modelSpan = spans.find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      const toolSpan = spans.find((s) => s.name.startsWith(GEN_AI_OPERATION_EXECUTE_TOOL));

      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      if (toolSpan === undefined) throw new Error("toolSpan should be defined");
      expect(parentSpanId(toolSpan)).toBe(modelSpan.spanContext().spanId);
    });

    test("tool span falls back to session span when no model call precedes it", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      // Tool call with NO preceding model call
      otel.onStep(SESSION_ID, makeToolStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const spans = exporter.getFinishedSpans();
      const sessionSpan = spans.find((s) => s.name.startsWith(GEN_AI_OPERATION_INVOKE_AGENT));
      const toolSpan = spans.find((s) => s.name.startsWith(GEN_AI_OPERATION_EXECUTE_TOOL));

      if (sessionSpan === undefined) throw new Error("sessionSpan should be defined");
      if (toolSpan === undefined) throw new Error("toolSpan should be defined");
      expect(parentSpanId(toolSpan)).toBe(sessionSpan.spanContext().spanId);
    });

    test("sets ERROR status on failure outcome", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeToolStep({ outcome: "failure" }));
      await otel.middleware.onSessionEnd?.(ctx as never);

      const toolSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_EXECUTE_TOOL));
      if (toolSpan === undefined) throw new Error("toolSpan should be defined");
      expect(toolSpan.status.code).toBe(SpanStatusCode.ERROR);
    });
  });

  // -------------------------------------------------------------------------
  // Issue 11A: captureContent: false → NO span events (negative assertion)
  // -------------------------------------------------------------------------

  describe("captureContent: false (default)", () => {
    test("model span has no events", async () => {
      const otel = createOtelMiddleware({ captureContent: false });
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep());
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      expect(modelSpan.events).toHaveLength(0);
    });

    test("no gen_ai.user.message event emitted", async () => {
      const otel = createOtelMiddleware({ captureContent: false });
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep({ request: { text: "secret prompt" } }));
      await otel.middleware.onSessionEnd?.(ctx as never);

      const spans = exporter.getFinishedSpans();
      const allEvents = spans.flatMap((s) => s.events);
      const contentEvents = allEvents.filter(
        (e) => e.name === EVENT_GEN_AI_USER_MESSAGE || e.name === EVENT_GEN_AI_CHOICE,
      );
      expect(contentEvents).toHaveLength(0);
    });
  });

  // Issue 11A continued: captureContent: true → events present
  describe("captureContent: true", () => {
    test("model span includes gen_ai.user.message event", async () => {
      const otel = createOtelMiddleware({ captureContent: true });
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep({ request: { text: "Hello, world!" } }));
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      const userEvent = modelSpan.events.find((e) => e.name === EVENT_GEN_AI_USER_MESSAGE);
      if (userEvent === undefined) throw new Error("userEvent should be defined");
      expect(userEvent.attributes?.["gen_ai.prompt"]).toBe("Hello, world!");
    });

    test("model span includes gen_ai.choice event", async () => {
      const otel = createOtelMiddleware({ captureContent: true });
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      otel.onStep(SESSION_ID, makeModelStep({ response: { text: "Hi there!" } }));
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      const choiceEvent = modelSpan.events.find((e) => e.name === EVENT_GEN_AI_CHOICE);
      if (choiceEvent === undefined) throw new Error("choiceEvent should be defined");
      expect(choiceEvent.attributes?.["gen_ai.completion"]).toBe("Hi there!");
    });

    test("no events emitted when request/response text is absent", async () => {
      const otel = createOtelMiddleware({ captureContent: true });
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      // Step with no text content (data-only request, no response)
      const stepNoContent = makeModelStep({ request: { data: { key: "val" } } });
      // Remove response to test absence of content events
      const { response: _r, ...stepWithoutResponse } = stepNoContent;
      otel.onStep(SESSION_ID, stepWithoutResponse as typeof stepNoContent);
      await otel.middleware.onSessionEnd?.(ctx as never);

      const modelSpan = exporter
        .getFinishedSpans()
        .find((s) => s.name.startsWith(GEN_AI_OPERATION_CHAT));
      if (modelSpan === undefined) throw new Error("modelSpan should be defined");
      expect(modelSpan.events).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Issue 12A: Throwing exporter — observer-never-throws
  // -------------------------------------------------------------------------

  describe("throwing exporter", () => {
    test("onStep does not propagate exporter errors", async () => {
      // Register a throwing exporter — simulates network failure during OTLP export
      const throwingExporter = new InMemorySpanExporter();
      throwingExporter.export = (_spans, _cb) => {
        throw new Error("OTLP endpoint unreachable");
      };

      const throwingProvider = new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(throwingExporter)],
      });
      trace.setGlobalTracerProvider(throwingProvider);

      const errors: unknown[] = [];
      const otel = createOtelMiddleware({
        onSpanError: (e) => errors.push(e),
      });

      const ctx = makeSessionCtx();

      // These should NOT throw, even with a broken exporter
      await otel.middleware.onSessionStart?.(ctx as never);
      expect(() => otel.onStep(SESSION_ID, makeModelStep())).not.toThrow();
      await otel.middleware.onSessionEnd?.(ctx as never);
    });

    test("provenance summary steps are silently skipped", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      // Internal provenance step — should produce no span
      otel.onStep(SESSION_ID, {
        stepIndex: 5,
        timestamp: 3_000,
        source: "system",
        kind: "tool_call",
        identifier: "provenance:turn_summary",
        outcome: "success",
        durationMs: 0,
      });

      await otel.middleware.onSessionEnd?.(ctx as never);

      const spans = exporter.getFinishedSpans();
      const provenanceSpan = spans.find((s) => s.name.includes("provenance"));
      expect(provenanceSpan).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Multiple sessions isolation
  // -------------------------------------------------------------------------

  describe("session isolation", () => {
    test("steps for different sessions produce independent span trees", async () => {
      const otel = createOtelMiddleware();
      const ctx1 = makeSessionCtx("sess-A", "agent-1");
      const ctx2 = makeSessionCtx("sess-B", "agent-2");

      await otel.middleware.onSessionStart?.(ctx1 as never);
      await otel.middleware.onSessionStart?.(ctx2 as never);

      otel.onStep("sess-A", makeModelStep({ identifier: "gpt-4o" }));
      otel.onStep("sess-B", makeModelStep({ identifier: "claude-3-5-sonnet" }));

      await otel.middleware.onSessionEnd?.(ctx1 as never);
      await otel.middleware.onSessionEnd?.(ctx2 as never);

      const spans = exporter.getFinishedSpans();
      const sessARoot = spans.find(
        (s) =>
          s.name.startsWith(GEN_AI_OPERATION_INVOKE_AGENT) &&
          s.attributes[ATTR_KOI_SESSION_ID] === "sess-A",
      );
      const sessBRoot = spans.find(
        (s) =>
          s.name.startsWith(GEN_AI_OPERATION_INVOKE_AGENT) &&
          s.attributes[ATTR_KOI_SESSION_ID] === "sess-B",
      );

      if (sessARoot === undefined) throw new Error("sessARoot should be defined");
      if (sessBRoot === undefined) throw new Error("sessBRoot should be defined");
      // Different trace IDs — truly independent trees
      expect(sessARoot.spanContext().traceId).not.toBe(sessBRoot.spanContext().traceId);
    });
  });

  // -------------------------------------------------------------------------
  // ATIF stamping — onStep returns OTel coordinates for event-trace to merge
  // -------------------------------------------------------------------------

  describe("ATIF trace stamping", () => {
    test("onStep returns otel.traceId and otel.spanId for model_call", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      const result = otel.onStep(SESSION_ID, makeModelStep());

      expect(result).toBeDefined();
      if (result === undefined) throw new Error("result should be defined");
      expect(typeof result["otel.traceId"]).toBe("string");
      expect(typeof result["otel.spanId"]).toBe("string");
      expect(result["otel.traceId"].length).toBe(32); // W3C traceId = 128-bit hex
      expect(result["otel.spanId"].length).toBe(16); // W3C spanId = 64-bit hex
    });

    test("onStep returns otel.traceId and otel.spanId for tool_call", async () => {
      const otel = createOtelMiddleware();
      const ctx = makeSessionCtx();
      await otel.middleware.onSessionStart?.(ctx as never);

      const result = otel.onStep(SESSION_ID, makeToolStep());

      expect(result).toBeDefined();
      if (result === undefined) throw new Error("result should be defined");
      expect(typeof result["otel.traceId"]).toBe("string");
      expect(typeof result["otel.spanId"]).toBe("string");
    });

    test("onStep returns undefined for provenance steps (skipped)", () => {
      const otel = createOtelMiddleware();
      const result = otel.onStep(SESSION_ID, {
        stepIndex: 0,
        timestamp: 1_000,
        source: "system",
        kind: "tool_call",
        identifier: "provenance:turn_summary",
        outcome: "success",
        durationMs: 0,
      });
      expect(result).toBeUndefined();
    });
  });
});

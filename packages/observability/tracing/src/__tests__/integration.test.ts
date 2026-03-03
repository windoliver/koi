import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { runId, sessionId } from "@koi/core";
import type { ToolRequest } from "@koi/core/middleware";
import {
  createMockModelHandler,
  createMockSessionContext,
  createMockToolHandler,
  createMockTurnContext,
} from "@koi/test-utils";
import { context as otelContext, propagation, type Tracer } from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { createTracedFetch } from "../traced-fetch.js";
import { createTracingMiddleware } from "../tracing.js";

/** Asserts that an optional middleware hook is defined. */
function assertDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${name} to be defined`);
  }
  return value;
}

describe("tracing integration", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let tracer: Tracer;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    tracer = provider.getTracer("@koi/integration");
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
  });

  test("full session lifecycle produces correct span tree", async () => {
    const middleware = createTracingMiddleware({ tracer });
    const onSessionStart = assertDefined(middleware.onSessionStart, "onSessionStart");
    const onSessionEnd = assertDefined(middleware.onSessionEnd, "onSessionEnd");
    const onBeforeTurn = assertDefined(middleware.onBeforeTurn, "onBeforeTurn");
    const onAfterTurn = assertDefined(middleware.onAfterTurn, "onAfterTurn");
    const wrapModelCall = assertDefined(middleware.wrapModelCall, "wrapModelCall");
    const wrapToolCall = assertDefined(middleware.wrapToolCall, "wrapToolCall");

    const sessionCtx = createMockSessionContext({ sessionId: sessionId("int-sess-1") });
    const turnCtx = createMockTurnContext({
      turnIndex: 0,
      session: {
        sessionId: sessionId("int-sess-1"),
        runId: runId("run-test-1"),
        agentId: "agent-test-1",
        metadata: {},
      },
    });

    await onSessionStart(sessionCtx);
    await onBeforeTurn(turnCtx);
    await wrapModelCall(turnCtx, { messages: [] }, createMockModelHandler());
    await wrapToolCall(turnCtx, { toolId: "search", input: {} }, createMockToolHandler());
    await onAfterTurn(turnCtx);
    await onSessionEnd(sessionCtx);

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(4); // session + turn + model + tool

    const sessionSpan = spans.find((s) => s.name === "koi.session");
    const turnSpan = spans.find((s) => s.name === "koi.turn");
    const modelSpan = spans.find((s) => s.name === "gen_ai.chat");
    const toolSpan = spans.find((s) => s.name === "koi.tool_call");

    expect(sessionSpan).toBeDefined();
    expect(turnSpan).toBeDefined();
    expect(modelSpan).toBeDefined();
    expect(toolSpan).toBeDefined();

    // Verify hierarchy: session -> turn -> model/tool
    if (sessionSpan && turnSpan && modelSpan && toolSpan) {
      expect(turnSpan.parentSpanContext?.spanId).toBe(sessionSpan.spanContext().spanId);
      expect(modelSpan.parentSpanContext?.spanId).toBe(turnSpan.spanContext().spanId);
      expect(toolSpan.parentSpanContext?.spanId).toBe(turnSpan.spanContext().spanId);
    }
  });

  test("concurrent sessions have isolated span contexts", async () => {
    const middleware = createTracingMiddleware({ tracer });
    const onSessionStart = assertDefined(middleware.onSessionStart, "onSessionStart");
    const onSessionEnd = assertDefined(middleware.onSessionEnd, "onSessionEnd");
    const onBeforeTurn = assertDefined(middleware.onBeforeTurn, "onBeforeTurn");
    const onAfterTurn = assertDefined(middleware.onAfterTurn, "onAfterTurn");
    const wrapModelCall = assertDefined(middleware.wrapModelCall, "wrapModelCall");

    const sess1 = createMockSessionContext({ sessionId: sessionId("sess-A") });
    const sess2 = createMockSessionContext({ sessionId: sessionId("sess-B") });
    const turn1 = createMockTurnContext({
      turnIndex: 0,
      session: {
        sessionId: sessionId("sess-A"),
        runId: runId("run-A"),
        agentId: "agent-test-1",
        metadata: {},
      },
    });
    const turn2 = createMockTurnContext({
      turnIndex: 0,
      session: {
        sessionId: sessionId("sess-B"),
        runId: runId("run-B"),
        agentId: "agent-test-1",
        metadata: {},
      },
    });

    await onSessionStart(sess1);
    await onSessionStart(sess2);

    await onBeforeTurn(turn1);
    await onBeforeTurn(turn2);
    await wrapModelCall(turn1, { messages: [] }, createMockModelHandler());
    await wrapModelCall(turn2, { messages: [] }, createMockModelHandler());
    await onAfterTurn(turn1);
    await onAfterTurn(turn2);

    await onSessionEnd(sess1);
    await onSessionEnd(sess2);

    const spans = exporter.getFinishedSpans();
    const sessionSpans = spans.filter((s) => s.name === "koi.session");
    const turnSpans = spans.filter((s) => s.name === "koi.turn");
    const modelSpans = spans.filter((s) => s.name === "gen_ai.chat");

    expect(sessionSpans).toHaveLength(2);
    expect(turnSpans).toHaveLength(2);
    expect(modelSpans).toHaveLength(2);

    const sessASpan = sessionSpans.find((s) => s.attributes["koi.session.id"] === "sess-A");
    const sessBSpan = sessionSpans.find((s) => s.attributes["koi.session.id"] === "sess-B");
    expect(sessASpan).toBeDefined();
    expect(sessBSpan).toBeDefined();

    if (sessASpan && sessBSpan) {
      const turnA = turnSpans.find(
        (s) => s.parentSpanContext?.spanId === sessASpan.spanContext().spanId,
      );
      const turnB = turnSpans.find(
        (s) => s.parentSpanContext?.spanId === sessBSpan.spanContext().spanId,
      );
      expect(turnA).toBeDefined();
      expect(turnB).toBeDefined();

      if (turnA && turnB) {
        const modelA = modelSpans.find(
          (s) => s.parentSpanContext?.spanId === turnA.spanContext().spanId,
        );
        const modelB = modelSpans.find(
          (s) => s.parentSpanContext?.spanId === turnB.spanContext().spanId,
        );
        expect(modelA).toBeDefined();
        expect(modelB).toBeDefined();
      }
    }
  });

  test("noop behavior without TracerProvider", async () => {
    // Use the default global tracer (no provider registered = noop)
    const noopMiddleware = createTracingMiddleware({ serviceName: "@koi/noop" });
    const onSessionStart = assertDefined(noopMiddleware.onSessionStart, "onSessionStart");
    const onSessionEnd = assertDefined(noopMiddleware.onSessionEnd, "onSessionEnd");
    const onBeforeTurn = assertDefined(noopMiddleware.onBeforeTurn, "onBeforeTurn");
    const onAfterTurn = assertDefined(noopMiddleware.onAfterTurn, "onAfterTurn");
    const wrapModelCall = assertDefined(noopMiddleware.wrapModelCall, "wrapModelCall");

    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const next = createMockModelHandler({ content: "passthrough" });

    await onSessionStart(sessionCtx);
    await onBeforeTurn(turnCtx);
    const response = await wrapModelCall(turnCtx, { messages: [] }, next);
    await onAfterTurn(turnCtx);
    await onSessionEnd(sessionCtx);

    // Response passes through untouched
    expect(response.content).toBe("passthrough");
    // No spans in our test exporter (the noop tracer doesn't report to our exporter)
    // This verifies no errors occurred
  });

  test("multiple turns in single session produce sibling turn spans", async () => {
    const middleware = createTracingMiddleware({ tracer });
    const onSessionStart = assertDefined(middleware.onSessionStart, "onSessionStart");
    const onSessionEnd = assertDefined(middleware.onSessionEnd, "onSessionEnd");
    const onBeforeTurn = assertDefined(middleware.onBeforeTurn, "onBeforeTurn");
    const onAfterTurn = assertDefined(middleware.onAfterTurn, "onAfterTurn");
    const wrapModelCall = assertDefined(middleware.wrapModelCall, "wrapModelCall");

    const sessionCtx = createMockSessionContext({ sessionId: sessionId("multi-turn") });

    await onSessionStart(sessionCtx);

    const turn0 = createMockTurnContext({
      turnIndex: 0,
      session: {
        sessionId: sessionId("multi-turn"),
        runId: runId("run-multi"),
        agentId: "agent-test-1",
        metadata: {},
      },
    });
    await onBeforeTurn(turn0);
    await wrapModelCall(turn0, { messages: [] }, createMockModelHandler());
    await onAfterTurn(turn0);

    const turn1 = createMockTurnContext({
      turnIndex: 1,
      session: {
        sessionId: sessionId("multi-turn"),
        runId: runId("run-multi"),
        agentId: "agent-test-1",
        metadata: {},
      },
    });
    await onBeforeTurn(turn1);
    await wrapModelCall(turn1, { messages: [] }, createMockModelHandler());
    await onAfterTurn(turn1);

    await onSessionEnd(sessionCtx);

    const spans = exporter.getFinishedSpans();
    const sessionSpan = spans.find((s) => s.name === "koi.session");
    const turnSpans = spans.filter((s) => s.name === "koi.turn");

    expect(turnSpans).toHaveLength(2);
    expect(sessionSpan).toBeDefined();

    if (sessionSpan) {
      for (const ts of turnSpans) {
        expect(ts.parentSpanContext?.spanId).toBe(sessionSpan.spanContext().spanId);
      }
    }

    const indices = turnSpans.map((ts) => ts.attributes["koi.turn.index"]);
    expect(indices).toContain(0);
    expect(indices).toContain(1);
  });
});

/**
 * Context propagation tests need provider.register() so that the
 * AsyncLocalStorage-based context manager is active. This is a separate
 * describe block to isolate the global registration side effects.
 */
describe("tracing context propagation", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    // register() activates context manager + propagator (W3C by default)
    provider.register({
      propagator: new W3CTraceContextPropagator(),
    });
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
    // Reset global state so other tests aren't affected
    propagation.disable();
    otelContext.disable();
  });

  test("context.with() propagates trace context into tool call handler", async () => {
    const tracer = provider.getTracer("@koi/propagation-test");
    const middleware = createTracingMiddleware({ tracer });
    const onSessionStart = assertDefined(middleware.onSessionStart, "onSessionStart");
    const onSessionEnd = assertDefined(middleware.onSessionEnd, "onSessionEnd");
    const onBeforeTurn = assertDefined(middleware.onBeforeTurn, "onBeforeTurn");
    const onAfterTurn = assertDefined(middleware.onAfterTurn, "onAfterTurn");
    const wrapToolCall = assertDefined(middleware.wrapToolCall, "wrapToolCall");

    const sessionCtx = createMockSessionContext({ sessionId: sessionId("ctx-prop") });
    const turnCtx = createMockTurnContext({
      turnIndex: 0,
      session: {
        sessionId: sessionId("ctx-prop"),
        runId: runId("run-ctx-prop"),
        agentId: "agent-test-1",
        metadata: {},
      },
    });

    await onSessionStart(sessionCtx);
    await onBeforeTurn(turnCtx);

    // Use a tool handler that calls createTracedFetch with a spy
    let capturedHeaders: Record<string, string> | undefined;
    const spyFetch = mock((_input: Request | string | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers as Record<string, string>;
      return Promise.resolve(new Response("ok"));
    });

    const toolHandler = async (_req: ToolRequest) => {
      const tracedFetch = createTracedFetch(spyFetch);
      await tracedFetch("https://example.com/api", {
        headers: { "Content-Type": "application/json" },
      });
      return { output: { result: "ok" } };
    };

    await wrapToolCall(turnCtx, { toolId: "http-tool", input: {} }, toolHandler);

    await onAfterTurn(turnCtx);
    await onSessionEnd(sessionCtx);

    // Verify traceparent was injected
    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders?.traceparent).toBeDefined();
    expect(capturedHeaders?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

    // Verify the traceparent's trace-id matches the tool span's trace-id
    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === "koi.tool_call");
    expect(toolSpan).toBeDefined();
    if (toolSpan && capturedHeaders?.traceparent) {
      const traceId = capturedHeaders.traceparent.split("-")[1];
      expect(traceId).toBe(toolSpan.spanContext().traceId);
    }

    // Verify existing headers were preserved
    expect(capturedHeaders?.["Content-Type"]).toBe("application/json");
  });
});

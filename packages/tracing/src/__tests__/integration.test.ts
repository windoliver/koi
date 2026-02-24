import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runId, sessionId } from "@koi/core";
import {
  createMockModelHandler,
  createMockSessionContext,
  createMockToolHandler,
  createMockTurnContext,
} from "@koi/test-utils";
import type { Tracer } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
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

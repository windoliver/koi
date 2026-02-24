import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runId, sessionId } from "@koi/core";
import type { KoiMiddleware, ModelChunk, ModelRequest, ModelResponse } from "@koi/core/middleware";
import {
  createMockModelHandler,
  createMockSessionContext,
  createMockToolHandler,
  createMockTurnContext,
} from "@koi/test-utils";
import type { Tracer } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  GEN_AI_OPERATION_NAME,
  GEN_AI_REQUEST_MODEL,
  GEN_AI_RESPONSE_MODEL,
  GEN_AI_USAGE_INPUT_TOKENS,
  GEN_AI_USAGE_OUTPUT_TOKENS,
  KOI_AGENT_ID,
  KOI_REQUEST_CONTENT,
  KOI_RESPONSE_CONTENT,
  KOI_SESSION_ID,
  KOI_TOOL_ID,
  KOI_TURN_INDEX,
} from "./semantic-conventions.js";
import { createTracingMiddleware } from "./tracing.js";

/** Asserts that an optional middleware hook is defined. */
function assertDefined<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`Expected ${name} to be defined`);
  }
  return value;
}

/** Typed accessors for the optional middleware hooks under test. */
function hooks(mw: KoiMiddleware) {
  return {
    onSessionStart: assertDefined(mw.onSessionStart, "onSessionStart"),
    onSessionEnd: assertDefined(mw.onSessionEnd, "onSessionEnd"),
    onBeforeTurn: assertDefined(mw.onBeforeTurn, "onBeforeTurn"),
    onAfterTurn: assertDefined(mw.onAfterTurn, "onAfterTurn"),
    wrapModelCall: assertDefined(mw.wrapModelCall, "wrapModelCall"),
    wrapModelStream: assertDefined(mw.wrapModelStream, "wrapModelStream"),
    wrapToolCall: assertDefined(mw.wrapToolCall, "wrapToolCall"),
  };
}

/** Creates a test TracerProvider + Exporter + Tracer bundle. */
function createTestTracer(): {
  readonly exporter: InMemorySpanExporter;
  readonly provider: NodeTracerProvider;
  readonly tracer: Tracer;
} {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  const tracer = provider.getTracer("@koi/test");
  return { exporter, provider, tracer };
}

describe("createTracingMiddleware", () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let tracer: Tracer;
  let middleware: KoiMiddleware;

  beforeEach(() => {
    const t = createTestTracer();
    exporter = t.exporter;
    provider = t.provider;
    tracer = t.tracer;
    middleware = createTracingMiddleware({ tracer });
  });

  afterEach(async () => {
    exporter.reset();
    await provider.shutdown();
  });

  test("creates session span on onSessionStart", async () => {
    const ctx = createMockSessionContext({ sessionId: sessionId("sess-1"), agentId: "agent-1" });
    const h = hooks(middleware);

    await h.onSessionStart(ctx);
    await h.onSessionEnd(ctx);

    const spans = exporter.getFinishedSpans();
    const sessionSpan = spans.find((s) => s.name === "koi.session");
    expect(sessionSpan).toBeDefined();
    expect(sessionSpan?.attributes[KOI_SESSION_ID]).toBe("sess-1");
    expect(sessionSpan?.attributes[KOI_AGENT_ID]).toBe("agent-1");
  });

  test("ends session span on onSessionEnd", async () => {
    const ctx = createMockSessionContext();
    const h = hooks(middleware);

    await h.onSessionStart(ctx);
    await h.onSessionEnd(ctx);

    const spans = exporter.getFinishedSpans();
    const sessionSpan = spans.find((s) => s.name === "koi.session");
    expect(sessionSpan).toBeDefined();
    expect(sessionSpan?.endTime).toBeDefined();
  });

  test("creates turn span as child of session span", async () => {
    const sessionCtx = createMockSessionContext({ sessionId: sessionId("sess-1") });
    const turnCtx = createMockTurnContext({
      turnIndex: 0,
      session: {
        sessionId: sessionId("sess-1"),
        runId: runId("run-test-1"),
        agentId: "agent-test-1",
        metadata: {},
      },
    });
    const h = hooks(middleware);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);
    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const spans = exporter.getFinishedSpans();
    const sessionSpan = spans.find((s) => s.name === "koi.session");
    const turnSpan = spans.find((s) => s.name === "koi.turn");

    expect(sessionSpan).toBeDefined();
    expect(turnSpan).toBeDefined();
    expect(turnSpan?.attributes[KOI_TURN_INDEX]).toBe(0);
    if (sessionSpan && turnSpan) {
      expect(turnSpan.parentSpanContext?.spanId).toBe(sessionSpan.spanContext().spanId);
    }
  });

  test("ends turn span on onAfterTurn", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const h = hooks(middleware);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);
    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const turnSpan = exporter.getFinishedSpans().find((s) => s.name === "koi.turn");
    expect(turnSpan).toBeDefined();
    expect(turnSpan?.endTime).toBeDefined();
  });

  test("creates model call span as child of turn span", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const next = createMockModelHandler();
    const h = hooks(middleware);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);
    await h.wrapModelCall(turnCtx, { messages: [], model: "gpt-4" }, next);
    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const spans = exporter.getFinishedSpans();
    const turnSpan = spans.find((s) => s.name === "koi.turn");
    const modelSpan = spans.find((s) => s.name === "gen_ai.chat");

    expect(modelSpan).toBeDefined();
    expect(modelSpan?.attributes[GEN_AI_OPERATION_NAME]).toBe("chat");
    expect(modelSpan?.attributes[GEN_AI_REQUEST_MODEL]).toBe("gpt-4");

    if (turnSpan && modelSpan) {
      expect(modelSpan.parentSpanContext?.spanId).toBe(turnSpan.spanContext().spanId);
    }
  });

  test("records token usage on model call span", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const next = createMockModelHandler({
      model: "gpt-4",
      usage: { inputTokens: 100, outputTokens: 50 },
    });
    const h = hooks(middleware);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);
    await h.wrapModelCall(turnCtx, { messages: [] }, next);
    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const modelSpan = exporter.getFinishedSpans().find((s) => s.name === "gen_ai.chat");
    expect(modelSpan).toBeDefined();
    expect(modelSpan?.attributes[GEN_AI_RESPONSE_MODEL]).toBe("gpt-4");
    expect(modelSpan?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(100);
    expect(modelSpan?.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(50);
  });

  test("records error on model call failure", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const failingNext = async (_req: ModelRequest): Promise<ModelResponse> => {
      throw new Error("model exploded");
    };
    const h = hooks(middleware);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);

    await expect(h.wrapModelCall(turnCtx, { messages: [] }, failingNext)).rejects.toThrow(
      "model exploded",
    );

    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const modelSpan = exporter.getFinishedSpans().find((s) => s.name === "gen_ai.chat");
    expect(modelSpan).toBeDefined();
    expect(modelSpan?.status.code).toBe(2); // SpanStatusCode.ERROR = 2
    expect(modelSpan?.events.length).toBeGreaterThan(0);
    expect(modelSpan?.events[0]?.name).toBe("exception");
  });

  test("creates tool call span with correct attributes", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const next = createMockToolHandler({ output: { result: "ok" } });
    const h = hooks(middleware);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);
    await h.wrapToolCall(turnCtx, { toolId: "web-search", input: { q: "koi" } }, next);
    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === "koi.tool_call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.attributes[KOI_TOOL_ID]).toBe("web-search");
  });

  test("records error on tool call failure", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const failingNext = async () => {
      throw new Error("tool crashed");
    };
    const h = hooks(middleware);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);

    await expect(
      h.wrapToolCall(turnCtx, { toolId: "broken", input: {} }, failingNext),
    ).rejects.toThrow("tool crashed");

    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const toolSpan = exporter.getFinishedSpans().find((s) => s.name === "koi.tool_call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan?.status.code).toBe(2); // ERROR
    expect(toolSpan?.events[0]?.name).toBe("exception");
  });

  test("handles streaming model call", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const h = hooks(middleware);

    const mockChunks: readonly ModelChunk[] = [
      { kind: "text_delta", delta: "hello" },
      { kind: "text_delta", delta: " world" },
      {
        kind: "done",
        response: {
          content: "hello world",
          model: "gpt-4",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
      },
    ];
    const streamNext = async function* (_request: ModelRequest): AsyncIterable<ModelChunk> {
      for (const chunk of mockChunks) {
        yield chunk;
      }
    };

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);

    const chunks: ModelChunk[] = [];
    for await (const chunk of h.wrapModelStream(turnCtx, { messages: [] }, streamNext)) {
      chunks.push(chunk);
    }

    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    expect(chunks).toHaveLength(3);

    const streamSpan = exporter.getFinishedSpans().find((s) => s.name === "gen_ai.stream");
    expect(streamSpan).toBeDefined();
    expect(streamSpan?.attributes[GEN_AI_USAGE_INPUT_TOKENS]).toBe(10);
    expect(streamSpan?.attributes[GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(5);
  });

  test("handles streaming error mid-stream", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const h = hooks(middleware);

    const streamNext = async function* (_request: ModelRequest): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta" as const, delta: "partial" };
      throw new Error("stream failed");
    };

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);

    const chunks: ModelChunk[] = [];
    await expect(async () => {
      for await (const chunk of h.wrapModelStream(turnCtx, { messages: [] }, streamNext)) {
        chunks.push(chunk);
      }
    }).toThrow("stream failed");

    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    expect(chunks).toHaveLength(1);

    const streamSpan = exporter.getFinishedSpans().find((s) => s.name === "gen_ai.stream");
    expect(streamSpan).toBeDefined();
    expect(streamSpan?.status.code).toBe(2); // ERROR
    expect(streamSpan?.events[0]?.name).toBe("exception");
  });

  test("does not capture content by default", async () => {
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const next = createMockModelHandler();
    const h = hooks(middleware);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);
    await h.wrapModelCall(turnCtx, { messages: [] }, next);
    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const modelSpan = exporter.getFinishedSpans().find((s) => s.name === "gen_ai.chat");
    expect(modelSpan).toBeDefined();
    expect(modelSpan?.attributes[KOI_REQUEST_CONTENT]).toBeUndefined();
    expect(modelSpan?.attributes[KOI_RESPONSE_CONTENT]).toBeUndefined();
  });

  test("captures content when captureContent enabled", async () => {
    const mw = createTracingMiddleware({ tracer, captureContent: true });
    const sessionCtx = createMockSessionContext();
    const turnCtx = createMockTurnContext();
    const next = createMockModelHandler({ content: "response text" });
    const h = hooks(mw);

    await h.onSessionStart(sessionCtx);
    await h.onBeforeTurn(turnCtx);
    await h.wrapModelCall(turnCtx, { messages: [] }, next);
    await h.onAfterTurn(turnCtx);
    await h.onSessionEnd(sessionCtx);

    const modelSpan = exporter.getFinishedSpans().find((s) => s.name === "gen_ai.chat");
    expect(modelSpan).toBeDefined();
    expect(modelSpan?.attributes[KOI_REQUEST_CONTENT]).toBeDefined();
    expect(modelSpan?.attributes[KOI_RESPONSE_CONTENT]).toBeDefined();
    const responseContent = modelSpan?.attributes[KOI_RESPONSE_CONTENT];
    expect(typeof responseContent === "string" && responseContent.includes("response text")).toBe(
      true,
    );
  });

  test("tracing errors do not propagate to application", async () => {
    const errors: unknown[] = [];
    const brokenTracer = {
      startSpan: () => {
        throw new Error("tracer broken");
      },
    } as unknown as Tracer;

    const mw = createTracingMiddleware({
      tracer: brokenTracer,
      onError: (e) => errors.push(e),
    });
    const turnCtx = createMockTurnContext();
    const next = createMockModelHandler({ content: "still works" });
    const h = hooks(mw);

    const response = await h.wrapModelCall(turnCtx, { messages: [] }, next);
    expect(response.content).toBe("still works");
    expect(errors.length).toBeGreaterThan(0);
  });
});

import { describe, expect, test } from "bun:test";
import type {
  ModelChunk,
  ModelRequest,
  ModelResponse,
  SessionContext,
  SessionId,
  ToolCallId,
  TurnContext,
  TurnId,
} from "@koi/core";
import { createStrictAgenticMiddleware } from "./middleware.js";

function makeSession(sessionId = "s1"): SessionContext {
  return {
    agentId: "agent-1",
    sessionId: sessionId as unknown as SessionId,
    runId: "run-1" as unknown as SessionContext["runId"],
    metadata: {},
  };
}

function makeTurn(sessionId = "s1", turnId = "t1"): TurnContext {
  return {
    session: makeSession(sessionId),
    turnIndex: 0,
    turnId: turnId as unknown as TurnId,
    messages: [],
    metadata: {},
  };
}

const REQUEST: ModelRequest = { messages: [] };

function response(content: string, toolCalls: number): ModelResponse {
  const richContent = Array.from({ length: toolCalls }, (_, i) => ({
    kind: "tool_call" as const,
    id: `c${i}` as unknown as ToolCallId,
    name: "dummy",
    arguments: {},
  }));
  return toolCalls > 0 ? { content, model: "test", richContent } : { content, model: "test" };
}

describe("createStrictAgenticMiddleware", () => {
  test("no-op when enabled=false", async () => {
    const { middleware } = createStrictAgenticMiddleware({ enabled: false });
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("plan text", 0));
    const result = await middleware.onBeforeStop?.(turn);
    expect(result).toEqual({ kind: "continue" });
  });

  test("continues when no cached turn (first call)", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn();
    const result = await middleware.onBeforeStop?.(turn);
    expect(result).toEqual({ kind: "continue" });
  });

  test("continues on action turn (tool calls present)", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("", 1));
    const result = await middleware.onBeforeStop?.(turn);
    expect(result).toEqual({ kind: "continue" });
  });

  test("blocks filler turn", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () =>
      response("I will now do a thing.", 0),
    );
    const result = await middleware.onBeforeStop?.(turn);
    expect(result?.kind).toBe("block");
    if (result?.kind !== "block") return;
    expect(result.blockedBy).toBe("strict-agentic");
    expect(result.reason.length).toBeGreaterThan(0);
  });

  test("user-question turn is not blocked", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("Should I proceed?", 0));
    const result = await middleware.onBeforeStop?.(turn);
    expect(result).toEqual({ kind: "continue" });
  });

  test("explicit-done turn is not blocked", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () =>
      response("All tests pass — done.", 0),
    );
    const result = await middleware.onBeforeStop?.(turn);
    expect(result).toEqual({ kind: "continue" });
  });

  test("uses configured feedbackMessage", async () => {
    const { middleware } = createStrictAgenticMiddleware({ feedbackMessage: "CUSTOM FEEDBACK" });
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("planning", 0));
    const result = await middleware.onBeforeStop?.(turn);
    expect(result?.kind).toBe("block");
    if (result?.kind !== "block") return;
    expect(result.reason).toBe("CUSTOM FEEDBACK");
  });

  test("circuit breaker releases after maxFillerRetries consecutive blocks", async () => {
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({ maxFillerRetries: 2 });

    const seq = ["t1", "t2", "t3", "t4"];
    const kinds: string[] = [];
    for (const turnId of seq) {
      const turn = makeTurn("s1", turnId);
      await middleware.wrapModelCall?.(turn, REQUEST, async () => response("planning", 0));
      const r = await middleware.onBeforeStop?.(turn);
      kinds.push(r?.kind ?? "unknown");
    }

    // maxFillerRetries=2 means the 3rd filler turn exceeds the cap and continues.
    // Implementation: increment happens before the `> max` check, so block count after 3 calls is 3.
    expect(kinds.slice(0, 2)).toEqual(["block", "block"]);
    expect(kinds[2]).toBe("continue");
    expect(getBlockCount("s1")).toBeGreaterThanOrEqual(3);
  });

  test("counter resets after non-filler turn", async () => {
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({ maxFillerRetries: 3 });

    for (const t of ["t1", "t2"]) {
      const turn = makeTurn("s1", t);
      await middleware.wrapModelCall?.(turn, REQUEST, async () => response("planning", 0));
      await middleware.onBeforeStop?.(turn);
    }
    expect(getBlockCount("s1")).toBe(2);

    const actionTurn = makeTurn("s1", "t3");
    await middleware.wrapModelCall?.(actionTurn, REQUEST, async () => response("", 1));
    await middleware.onBeforeStop?.(actionTurn);
    expect(getBlockCount("s1")).toBe(0);
  });

  test("onAfterTurn clears turn cache", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("x", 1));
    await middleware.onAfterTurn?.(turn);
    const r = await middleware.onBeforeStop?.(turn);
    expect(r).toEqual({ kind: "continue" });
  });

  test("onSessionEnd clears block counter", async () => {
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({ maxFillerRetries: 5 });
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("plan", 0));
    await middleware.onBeforeStop?.(turn);
    expect(getBlockCount("s1")).toBe(1);
    await middleware.onSessionEnd?.(turn.session);
    expect(getBlockCount("s1")).toBe(0);
  });

  test("describeCapabilities returns label + description", () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn();
    const cap = middleware.describeCapabilities(turn);
    expect(cap).toBeTruthy();
    if (!cap) return;
    expect(cap.label).toBe("strict-agentic");
    expect(cap.description.length).toBeGreaterThan(0);
  });

  test("throws on malformed config (non-function predicate)", () => {
    expect(() =>
      createStrictAgenticMiddleware({
        // biome-ignore lint/suspicious/noExplicitAny: deliberate invalid value for guardrail test
        isExplicitDone: 42 as any,
      }),
    ).toThrow(/Invalid @koi\/middleware-strict-agentic config/);
  });

  test("throws on malformed config (negative maxFillerRetries)", () => {
    expect(() => createStrictAgenticMiddleware({ maxFillerRetries: -1 })).toThrow(
      /Invalid @koi\/middleware-strict-agentic config/,
    );
  });
});

// -------------------------------------------------------------------------
// wrapModelStream — runtime's streaming path must exercise the same gate
// -------------------------------------------------------------------------

async function collect(stream: AsyncIterable<ModelChunk>): Promise<ModelChunk[]> {
  const out: ModelChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

function streamOf(chunks: readonly ModelChunk[]): () => AsyncIterable<ModelChunk> {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  });
}

describe("wrapModelStream", () => {
  test("blocks filler turn when streamed response has no tool calls", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn("s-stream", "t-stream-1");

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "I will now " },
      { kind: "text_delta", delta: "proceed to work." },
      {
        kind: "done",
        response: { content: "I will now proceed to work.", model: "test" },
      },
    ];
    const stream = middleware.wrapModelStream?.(turn, REQUEST, streamOf(chunks));
    if (stream === undefined) throw new Error("wrapModelStream missing");
    const drained = await collect(stream);
    expect(drained.length).toBe(chunks.length);

    const result = await middleware.onBeforeStop?.(turn);
    expect(result?.kind).toBe("block");
  });

  test("passes tool-call turn on streamed response", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn("s-stream", "t-stream-2");

    const chunks: ModelChunk[] = [
      { kind: "tool_call_start", toolName: "x", callId: "c1" as unknown as ToolCallId },
      { kind: "tool_call_end", callId: "c1" as unknown as ToolCallId },
      {
        kind: "done",
        response: {
          content: "",
          model: "test",
          richContent: [
            {
              kind: "tool_call",
              id: "c1" as unknown as ToolCallId,
              name: "x",
              arguments: {},
            },
          ],
        },
      },
    ];
    const stream = middleware.wrapModelStream?.(turn, REQUEST, streamOf(chunks));
    if (stream === undefined) throw new Error("wrapModelStream missing");
    await collect(stream);

    const result = await middleware.onBeforeStop?.(turn);
    expect(result?.kind).toBe("continue");
  });

  test("falls back to chunk accumulation when adapter omits done chunk", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn("s-stream", "t-stream-3");

    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "I will plan this out." },
      // intentionally no "done" chunk — some adapters only emit usage + close
      { kind: "usage", inputTokens: 10, outputTokens: 5 },
    ];
    const stream = middleware.wrapModelStream?.(turn, REQUEST, streamOf(chunks));
    if (stream === undefined) throw new Error("wrapModelStream missing");
    await collect(stream);

    const result = await middleware.onBeforeStop?.(turn);
    expect(result?.kind).toBe("block");
  });

  test("noop mode passes stream through without recording", async () => {
    const { middleware } = createStrictAgenticMiddleware({ enabled: false });
    const turn = makeTurn("s-stream", "t-stream-4");
    const chunks: ModelChunk[] = [{ kind: "text_delta", delta: "plan only" }];
    const stream = middleware.wrapModelStream?.(turn, REQUEST, streamOf(chunks));
    if (stream === undefined) throw new Error("wrapModelStream missing");
    await collect(stream);

    const result = await middleware.onBeforeStop?.(turn);
    // enabled=false → onBeforeStop always continues regardless of stream content
    expect(result).toEqual({ kind: "continue" });
  });
});

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
    await middleware.wrapModelCall?.(turn, REQUEST, async () =>
      response("I will now plan this", 0),
    );
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
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("I will plan this", 0));
    const result = await middleware.onBeforeStop?.(turn);
    expect(result?.kind).toBe("block");
    if (result?.kind !== "block") return;
    expect(result.reason).toBe("CUSTOM FEEDBACK");
  });

  test("circuit breaker releases when blocks reach maxFillerRetries", async () => {
    // With maxFillerRetries=3, the 3rd consecutive stop-gate block trips the
    // breaker. This aligns with the engine's DEFAULT_MAX_STOP_RETRIES so the
    // release path is reachable before the runner stops consulting middleware.
    // On release the per-run counter + turn cache are cleared (the run is
    // ending).
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({ maxFillerRetries: 3 });

    const kinds: string[] = [];
    for (const turnId of ["t1", "t2", "t3"]) {
      const turn = makeTurn("s1", turnId);
      await middleware.wrapModelCall?.(turn, REQUEST, async () => response("I will plan this", 0));
      const r = await middleware.onBeforeStop?.(turn);
      kinds.push(r?.kind ?? "unknown");
    }

    // Calls 1 & 2 block (count=1, 2 < 3); call 3 releases (count=3 >= 3).
    expect(kinds).toEqual(["block", "block", "continue"]);
    // Counter cleared on release — the run has ended.
    expect(getBlockCount("run-1")).toBe(0);
  });

  test("counter resets after non-filler turn", async () => {
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({ maxFillerRetries: 3 });

    for (const t of ["t1", "t2"]) {
      const turn = makeTurn("s1", t);
      await middleware.wrapModelCall?.(turn, REQUEST, async () =>
        response("I will now plan further steps", 0),
      );
      await middleware.onBeforeStop?.(turn);
    }
    expect(getBlockCount("run-1")).toBe(2);

    const actionTurn = makeTurn("s1", "t3");
    await middleware.wrapModelCall?.(actionTurn, REQUEST, async () => response("", 1));
    await middleware.onBeforeStop?.(actionTurn);
    expect(getBlockCount("run-1")).toBe(0);
  });

  test("successful continue on onBeforeStop clears turn cache + resets run counter", async () => {
    // Regression: onAfterTurn does NOT fire on a successful terminal `done`
    // in the engine contract — relying on it alone leaks one turn entry per
    // completed run() and any breaker counter for runs that tripped. The
    // guard now clears state eagerly on the continue path.
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({
      maxFillerRetries: 3,
    });
    const turn = makeTurn("s-cleanup", "t-cleanup");

    // Tool-call turn → classifier=action → continue path.
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("", 1));
    // Prior run had blocks → confirm they get reset on the continue path.
    expect(getBlockCount("run-1")).toBe(0); // fresh
    const r = await middleware.onBeforeStop?.(turn);
    expect(r?.kind).toBe("continue");
    // Subsequent onBeforeStop sees no cached turn → proves clearTurn ran.
    const r2 = await middleware.onBeforeStop?.(turn);
    expect(r2).toEqual({ kind: "continue" });
  });

  test("circuit-breaker release also clears turn cache + resets counter", async () => {
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({
      maxFillerRetries: 1,
    });
    const turn = makeTurn("s-breaker-cleanup", "t-br");
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("I will now plan", 0));
    const r = await middleware.onBeforeStop?.(turn);
    // With maxFillerRetries=1, first block trips the breaker immediately.
    expect(r?.kind).toBe("continue");
    // Counter cleared for this run → next run sees a fresh budget.
    expect(getBlockCount("run-1")).toBe(0);
  });

  test("onAfterTurn clears turn cache", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("x", 1));
    await middleware.onAfterTurn?.(turn);
    const r = await middleware.onBeforeStop?.(turn);
    expect(r).toEqual({ kind: "continue" });
  });

  test("onAfterTurn resets counter on non-blocked turn — tool turn clears prior filler blocks", async () => {
    // Regression: tool-use turns do NOT go through onBeforeStop (engine ends
    // them via turn_end). Without resetting in onAfterTurn on the non-blocked
    // path, a filler block earlier in the run leaks its counter across later
    // tool turns, so an unrelated filler much later trips the breaker after
    // only one strike instead of the full budget.
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({
      maxFillerRetries: 3,
    });

    // Turn 1: filler block → counter=1. Turn ends with stopBlocked=true.
    const filler = makeTurn("s-leak", "t-leak-1");
    await middleware.wrapModelCall?.(filler, REQUEST, async () => response("I will plan this", 0));
    await middleware.onBeforeStop?.(filler);
    expect(getBlockCount("run-1")).toBe(1);
    await middleware.onAfterTurn?.({ ...filler, stopBlocked: true });
    // Counter preserved because the turn was blocked.
    expect(getBlockCount("run-1")).toBe(1);

    // Turn 2: tool use — successful non-blocked turn. onAfterTurn without
    // stopBlocked should reset.
    const toolTurn = makeTurn("s-leak", "t-leak-2");
    await middleware.wrapModelCall?.(toolTurn, REQUEST, async () => response("", 1));
    await middleware.onAfterTurn?.(toolTurn);
    expect(getBlockCount("run-1")).toBe(0);

    // Turn 3: another filler. Counter was reset, so the full budget applies —
    // not a near-immediate fail-open from stale state.
    const filler2 = makeTurn("s-leak", "t-leak-3");
    await middleware.wrapModelCall?.(filler2, REQUEST, async () => response("I will plan more", 0));
    const r = await middleware.onBeforeStop?.(filler2);
    expect(r?.kind).toBe("block");
    expect(getBlockCount("run-1")).toBe(1);
  });

  test("onSessionEnd clears block counter", async () => {
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({ maxFillerRetries: 5 });
    const turn = makeTurn();
    await middleware.wrapModelCall?.(turn, REQUEST, async () => response("I will now proceed", 0));
    await middleware.onBeforeStop?.(turn);
    expect(getBlockCount("run-1")).toBe(1);
    await middleware.onSessionEnd?.(turn.session);
    expect(getBlockCount("run-1")).toBe(0);
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

  test("emits reportDecision when circuit breaker releases", async () => {
    // maxFillerRetries=2 → 2nd filler trips the breaker (blocks >= max).
    const { middleware } = createStrictAgenticMiddleware({ maxFillerRetries: 2 });
    const decisions: unknown[] = [];
    const mkCtx = (turnId: string): TurnContext => ({
      ...makeTurn("s-cb", turnId),
      reportDecision: (decision) => {
        decisions.push(decision);
      },
    });

    // First filler turn → block, no emission (count=1, 1 < 2).
    const t1 = mkCtx("cb-1");
    await middleware.wrapModelCall?.(t1, REQUEST, async () => response("I will plan this", 0));
    const r1 = await middleware.onBeforeStop?.(t1);
    expect(r1?.kind).toBe("block");
    expect(decisions.length).toBe(0);

    // Second filler turn → count=2 >= 2 → release + emit.
    const t2 = mkCtx("cb-2");
    await middleware.wrapModelCall?.(t2, REQUEST, async () => response("I will plan this", 0));
    const r2 = await middleware.onBeforeStop?.(t2);
    expect(r2?.kind).toBe("continue");
    expect(decisions.length).toBe(1);
    const [decision] = decisions as [Record<string, unknown>];
    expect(decision["event"]).toBe("strict-agentic:circuit-broken");
    expect(decision["sessionId"]).toBe("s-cb");
    expect(decision["runId"]).toBe("run-1");
    expect(decision["consecutiveBlocks"]).toBe(2);
    expect(decision["maxFillerRetries"]).toBe(2);
  });

  test("block counter is run-scoped — fresh runId starts from zero, not poisoned by prior run", async () => {
    // Regression: the counter was previously session-scoped, so an exhausted
    // prior request left a stale count at maxFillerRetries. The first filler
    // reply of the next request would then fail-open immediately, silently
    // disabling the guardrail. Keying by runId means each runtime.run() call
    // starts with a zero counter and cannot inherit poisoned state.
    const { middleware, getBlockCount } = createStrictAgenticMiddleware({
      maxFillerRetries: 2,
    });

    // Run 1: two filler turns — second trips the breaker. Verify block count
    // before breaker release (on the first filler, which just blocks).
    const run1Session: SessionContext = {
      ...makeSession("s-outer"),
      runId: "run-A" as unknown as SessionContext["runId"],
    };
    const t1: TurnContext = {
      session: run1Session,
      turnIndex: 0,
      turnId: "r1-t1" as unknown as TurnId,
      messages: [],
      metadata: {},
    };
    await middleware.wrapModelCall?.(t1, REQUEST, async () => response("I will plan", 0));
    await middleware.onBeforeStop?.(t1);
    expect(getBlockCount("run-A")).toBe(1);

    // Second filler → breaker trips → counter cleared for run-A.
    const t2: TurnContext = {
      session: run1Session,
      turnIndex: 0,
      turnId: "r1-t2" as unknown as TurnId,
      messages: [],
      metadata: {},
    };
    await middleware.wrapModelCall?.(t2, REQUEST, async () => response("I will plan", 0));
    await middleware.onBeforeStop?.(t2);
    expect(getBlockCount("run-A")).toBe(0);

    // Run 2: brand new runId — counter starts from zero naturally.
    const run2Session: SessionContext = {
      ...makeSession("s-outer"),
      runId: "run-B" as unknown as SessionContext["runId"],
    };
    expect(getBlockCount("run-B")).toBe(0);
    const nextTurn: TurnContext = {
      session: run2Session,
      turnIndex: 0,
      turnId: "r2-t1" as unknown as TurnId,
      messages: [],
      metadata: {},
    };
    await middleware.wrapModelCall?.(nextTurn, REQUEST, async () => response("I will plan", 0));
    const r = await middleware.onBeforeStop?.(nextTurn);
    // First filler of new run must block, not fail-open.
    expect(r?.kind).toBe("block");
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

  test("prefers streamed text when done chunk has empty response content", async () => {
    // Some adapters emit non-empty text_delta chunks then a done chunk where
    // response.content is "" (the done chunk is a lifecycle marker). The gate
    // must not reclassify a valid direct question as filler just because the
    // terminal response content is blank.
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn("s-stream", "t-stream-empty-done");
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "Should I proceed with the refactor?" },
      { kind: "done", response: { content: "", model: "test" } },
    ];
    const stream = middleware.wrapModelStream?.(turn, REQUEST, streamOf(chunks));
    if (stream === undefined) throw new Error("wrapModelStream missing");
    await collect(stream);

    // Streamed text ends with "?" → user-question → continue (not block)
    const result = await middleware.onBeforeStop?.(turn);
    expect(result?.kind).toBe("continue");
  });

  test("preserves streamed tool-call count when done omits richContent", async () => {
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn("s-stream", "t-stream-tool-done-bare");
    const chunks: ModelChunk[] = [
      { kind: "tool_call_start", toolName: "x", callId: "c1" as unknown as ToolCallId },
      { kind: "tool_call_end", callId: "c1" as unknown as ToolCallId },
      { kind: "done", response: { content: "", model: "test" } }, // no richContent
    ];
    const stream = middleware.wrapModelStream?.(turn, REQUEST, streamOf(chunks));
    if (stream === undefined) throw new Error("wrapModelStream missing");
    await collect(stream);

    // Tool call was observed via streamed chunks → action → continue
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

  test("records turn state before yielding done (survives iterator.return())", async () => {
    // Regression: consumeModelStream yields `done` and then immediately
    // return()s the iterator, which aborts the upstream generator before
    // its for-await loop exits naturally. If recordTurn were called AFTER
    // the loop, state would be lost and onBeforeStop would fail open.
    const { middleware } = createStrictAgenticMiddleware({});
    const turn = makeTurn("s-stream", "t-return-early");
    const chunks: ModelChunk[] = [
      { kind: "text_delta", delta: "I will proceed with the work." },
      { kind: "done", response: { content: "I will proceed with the work.", model: "test" } },
    ];
    const stream = middleware.wrapModelStream?.(turn, REQUEST, streamOf(chunks));
    if (stream === undefined) throw new Error("wrapModelStream missing");

    // Simulate consumeModelStream: read until done, then return() the iterator.
    const iter = stream[Symbol.asyncIterator]();
    for (;;) {
      const res = await iter.next();
      if (res.done === true) break;
      if (res.value.kind === "done") {
        await iter.return?.();
        break;
      }
    }

    const result = await middleware.onBeforeStop?.(turn);
    // State was recorded eagerly on `done` → classifier sees filler → block
    expect(result?.kind).toBe("block");
  });

  test("noop mode passes stream through without recording", async () => {
    const { middleware } = createStrictAgenticMiddleware({ enabled: false });
    const turn = makeTurn("s-stream", "t-stream-4");
    const chunks: ModelChunk[] = [{ kind: "text_delta", delta: "I will plan only" }];
    const stream = middleware.wrapModelStream?.(turn, REQUEST, streamOf(chunks));
    if (stream === undefined) throw new Error("wrapModelStream missing");
    await collect(stream);

    const result = await middleware.onBeforeStop?.(turn);
    // enabled=false → onBeforeStop always continues regardless of stream content
    expect(result).toEqual({ kind: "continue" });
  });
});

import { describe, expect, test } from "bun:test";
import type {
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
});

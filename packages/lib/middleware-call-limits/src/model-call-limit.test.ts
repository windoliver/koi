import { describe, expect, mock, test } from "bun:test";
import type { ModelHandler, ModelRequest, ModelResponse, TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import { KoiRuntimeError } from "@koi/errors";
import { createModelCallLimitMiddleware } from "./model-call-limit.js";
import type { LimitReachedInfo } from "./types.js";

function turnCtx(sid = "s-1"): TurnContext {
  const rid = runId(`r-${sid}`);
  return {
    session: { agentId: "a", sessionId: sessionId(sid), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function okHandler(): ModelHandler {
  return async (_req: ModelRequest): Promise<ModelResponse> => ({
    content: "ok",
    model: "test",
  });
}

describe("createModelCallLimitMiddleware", () => {
  test("allows up to limit", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 2 });
    const ctx = turnCtx();
    const r1 = await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    const r2 = await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    expect(r1?.content).toBe("ok");
    expect(r2?.content).toBe("ok");
  });

  test("throws RATE_LIMIT at limit+1", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 1 });
    const ctx = turnCtx();
    await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
      throw new Error("expected throw");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      expect((e as KoiRuntimeError).code).toBe("RATE_LIMIT");
    }
  });

  test("counters independent per session", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 1 });
    await mw.wrapModelCall?.(turnCtx("a"), { messages: [] }, okHandler());
    const r = await mw.wrapModelCall?.(turnCtx("b"), { messages: [] }, okHandler());
    expect(r?.content).toBe("ok");
  });

  test("onLimitReached fires once per session", async () => {
    const cb = mock((_info: LimitReachedInfo) => {});
    const mw = createModelCallLimitMiddleware({ limit: 1, onLimitReached: cb });
    const ctx = turnCtx();
    await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    } catch {}
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    } catch {}
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]?.[0].kind).toBe("model");
  });

  test("describeCapabilities mentions limit", () => {
    const mw = createModelCallLimitMiddleware({ limit: 7 });
    expect(mw.describeCapabilities(turnCtx())?.description).toContain("7");
  });

  // Regression: model cap MUST apply to streaming path. The runtime selects
  // modelStream when available, so wrapping only modelCall lets streamed
  // turns silently bypass the cap.
  test("wrapModelStream is also limited and shares the counter", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 2 });
    const ctx = turnCtx("stream-cap");
    async function* okStream(): AsyncIterable<import("@koi/core").ModelChunk> {
      yield { kind: "text_delta", delta: "x" };
      yield {
        kind: "done",
        response: { content: "x", model: "m" },
      };
    }
    // First call (non-stream)
    await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    // Second call (stream) — should still be allowed
    const s1 = mw.wrapModelStream?.(ctx, { messages: [] }, okStream);
    if (s1 === undefined) throw new Error("no stream");
    for await (const _c of s1) {
      // drain
    }
    // Third call (stream) — must throw RATE_LIMIT, sharing the counter
    let threw = false;
    try {
      const s2 = mw.wrapModelStream?.(ctx, { messages: [] }, okStream);
      if (s2 === undefined) throw new Error("no stream");
      for await (const _c of s2) {
        // drain
      }
    } catch (e: unknown) {
      threw = true;
      expect((e as { code?: string }).code).toBe("RATE_LIMIT");
    }
    expect(threw).toBe(true);
  });

  // Regression: failed/abandoned model attempts must NOT consume quota.
  // Otherwise a short burst of provider failures exhausts the budget and
  // every recovery attempt is hard-blocked with RATE_LIMIT.
  test("failed call refunds the counter", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 2 });
    const ctx = turnCtx("refund-call");
    const failHandler: ModelHandler = async () => {
      throw new Error("transient provider failure");
    };
    // Two failed attempts should not burn the budget.
    for (let i = 0; i < 2; i++) {
      try {
        await mw.wrapModelCall?.(ctx, { messages: [] }, failHandler);
      } catch {}
    }
    // Both successful calls must still go through.
    const r1 = await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    const r2 = await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    expect(r1?.content).toBe("ok");
    expect(r2?.content).toBe("ok");
  });

  test("upstream error chunk refunds the streaming counter", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 1 });
    const ctx = turnCtx("refund-error-chunk");
    async function* errStream(): AsyncIterable<import("@koi/core").ModelChunk> {
      yield {
        kind: "error",
        code: "INTERNAL",
        message: "upstream blew up",
        retryable: true,
      };
    }
    const s1 = mw.wrapModelStream?.(ctx, { messages: [] }, errStream);
    if (s1 === undefined) throw new Error("no stream");
    for await (const _c of s1) {
      // drain
    }
    // Counter refunded: subsequent successful call must succeed.
    const r = await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    expect(r?.content).toBe("ok");
  });

  test("abandoned stream (consumer break before done) refunds the counter", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 1 });
    const ctx = turnCtx("refund-abandoned");
    async function* slowStream(): AsyncIterable<import("@koi/core").ModelChunk> {
      yield { kind: "text_delta", delta: "x" };
      yield { kind: "text_delta", delta: "y" };
      yield {
        kind: "done",
        response: { content: "xy", model: "m" },
      };
    }
    const s1 = mw.wrapModelStream?.(ctx, { messages: [] }, slowStream);
    if (s1 === undefined) throw new Error("no stream");
    for await (const _c of s1) {
      // Break early — never reach `done`.
      break;
    }
    // Counter refunded: subsequent successful call must succeed.
    const r = await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    expect(r?.content).toBe("ok");
  });

  test("upstream sync throw before iterator refunds the counter", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 1 });
    const ctx = turnCtx("refund-sync-throw");
    const throwingNext = (() => {
      throw new Error("sync upstream failure");
    }) as unknown as Parameters<NonNullable<typeof mw.wrapModelStream>>[2];
    try {
      mw.wrapModelStream?.(ctx, { messages: [] }, throwingNext);
    } catch {}
    const r = await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    expect(r?.content).toBe("ok");
  });

  test("onSessionEnd resets counter so fresh session can run", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 1 });
    const ctx = turnCtx("model-cleanup");
    await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    let threw = false;
    try {
      await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    await mw.onSessionEnd?.(ctx.session);
    const r = await mw.wrapModelCall?.(ctx, { messages: [] }, okHandler());
    expect(r?.content).toBe("ok");
  });
});

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
});

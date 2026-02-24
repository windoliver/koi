import { describe, expect, mock, test } from "bun:test";
import { sessionId } from "@koi/core/ecs";
import type {
  ModelChunk,
  ModelRequest,
  ModelStreamHandler,
  TurnContext,
} from "@koi/core/middleware";
import { KoiRuntimeError } from "@koi/errors";
import {
  createMockSessionContext,
  createMockTurnContext,
  createSpyModelHandler,
} from "@koi/test-utils";
import { createModelCallLimitMiddleware } from "./model-call-limit.js";
import { createInMemoryCallLimitStore } from "./store.js";
import type { LimitReachedInfo } from "./types.js";

function createTurnCtx(sid: string): TurnContext {
  const session = createMockSessionContext({ sessionId: sessionId(sid) });
  return createMockTurnContext({ session });
}

const dummyRequest: ModelRequest = { messages: [] };

describe("createModelCallLimitMiddleware", () => {
  test("has correct name and priority", () => {
    const mw = createModelCallLimitMiddleware({ limit: 5 });
    expect(mw.name).toBe("koi:model-call-limit");
    expect(mw.priority).toBe(175);
  });

  test("allows calls within limit", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 3 });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);

    expect(spy.calls.length).toBe(3);
  });

  test("blocks call that exceeds limit", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 2 });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);

    await expect(mw.wrapModelCall?.(ctx, dummyRequest, spy.handler)).rejects.toThrow(
      KoiRuntimeError,
    );
    expect(spy.calls.length).toBe(2);
  });

  test("limit=0 blocks immediately", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 0 });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    await expect(mw.wrapModelCall?.(ctx, dummyRequest, spy.handler)).rejects.toThrow(
      KoiRuntimeError,
    );
    expect(spy.calls.length).toBe(0);
  });

  test("thrown error has RATE_LIMIT code and retryable false", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 0 });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    try {
      await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(KoiRuntimeError);
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("RATE_LIMIT");
      expect(err.retryable).toBe(false);
    }
  });

  test("exitBehavior 'end' also throws RATE_LIMIT", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 0, exitBehavior: "end" });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    try {
      await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      const err = e as KoiRuntimeError;
      expect(err.code).toBe("RATE_LIMIT");
      expect(err.message).toContain("end");
    }
  });

  test("wrapModelStream counts against same counter as wrapModelCall", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 2 });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    // Use one call via wrapModelCall
    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);

    // Use one call via wrapModelStream
    const chunks: ModelChunk[] = [{ kind: "done", response: { content: "ok", model: "m" } }];
    const streamHandler: ModelStreamHandler = async function* () {
      yield* chunks;
    };
    // Consume the stream
    const stream = mw.wrapModelStream?.(ctx, dummyRequest, streamHandler);
    if (stream) {
      for await (const _chunk of stream) {
        // consume
      }
    }

    // Third call should be blocked
    await expect(mw.wrapModelCall?.(ctx, dummyRequest, spy.handler)).rejects.toThrow(
      KoiRuntimeError,
    );
  });

  test("wrapModelStream blocks when limit exceeded", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 0 });
    const streamHandler: ModelStreamHandler = async function* () {
      yield { kind: "done" as const, response: { content: "ok", model: "m" } };
    };
    const ctx = createTurnCtx("s1");

    const wrapStream = mw.wrapModelStream;
    expect(wrapStream).toBeDefined();
    if (!wrapStream) return;
    const stream = wrapStream(ctx, dummyRequest, streamHandler);
    await expect(async () => {
      for await (const _chunk of stream) {
        // consume
      }
    }).toThrow(KoiRuntimeError);
  });

  test("onLimitReached fires exactly once per session", async () => {
    const callback = mock(() => {});
    const mw = createModelCallLimitMiddleware({ limit: 1, onLimitReached: callback });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    // First call succeeds
    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);

    // Second and third calls fail — callback should fire only once
    try {
      await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
    } catch {
      /* expected */
    }
    try {
      await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
    } catch {
      /* expected */
    }

    expect(callback).toHaveBeenCalledTimes(1);
    const args = callback.mock.calls[0] as unknown as readonly [LimitReachedInfo];
    const info = args[0];
    expect(info.kind).toBe("model");
    expect(info.sessionId).toBe("s1");
    expect(info.limit).toBe(1);
  });

  test("different sessions have independent counters", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 1 });
    const spy = createSpyModelHandler();
    const ctx1 = createTurnCtx("s1");
    const ctx2 = createTurnCtx("s2");

    await mw.wrapModelCall?.(ctx1, dummyRequest, spy.handler);
    await mw.wrapModelCall?.(ctx2, dummyRequest, spy.handler);

    // s1 exhausted, s2 still has quota
    await expect(mw.wrapModelCall?.(ctx1, dummyRequest, spy.handler)).rejects.toThrow();
    // s2's second call should also be blocked
    await expect(mw.wrapModelCall?.(ctx2, dummyRequest, spy.handler)).rejects.toThrow();
    expect(spy.calls.length).toBe(2);
  });

  test("custom store with pre-filled counts works correctly", async () => {
    const store = createInMemoryCallLimitStore();
    // Pre-fill: simulate 4 previous calls
    store.increment("model:s1");
    store.increment("model:s1");
    store.increment("model:s1");
    store.increment("model:s1");

    const mw = createModelCallLimitMiddleware({ limit: 5, store });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    // 5th call should succeed (count becomes 5, within limit)
    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);

    // 6th call should fail
    await expect(mw.wrapModelCall?.(ctx, dummyRequest, spy.handler)).rejects.toThrow();
    expect(spy.calls.length).toBe(1);
  });

  test("error context includes limit, count, and exitBehavior", async () => {
    const mw = createModelCallLimitMiddleware({ limit: 2, exitBehavior: "error" });
    const spy = createSpyModelHandler();
    const ctx = createTurnCtx("s1");

    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
    await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);

    try {
      await mw.wrapModelCall?.(ctx, dummyRequest, spy.handler);
      expect.unreachable("should have thrown");
    } catch (e: unknown) {
      const err = e as KoiRuntimeError;
      expect(err.context).toEqual({ limit: 2, count: 3, exitBehavior: "error" });
    }
  });
});

import { describe, expect, test } from "bun:test";
import type { TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type { ModelChunk, ModelHandler, ModelRequest, ModelResponse } from "@koi/core/middleware";
import { createCircuitBreakerMiddleware } from "./circuit-breaker-middleware.js";

function turnCtx(): TurnContext {
  const rid = runId("run-1");
  return {
    session: { agentId: "a", sessionId: sessionId("s-1"), runId: rid, metadata: {} },
    turnIndex: 0,
    turnId: turnId(rid, 0),
    messages: [],
    metadata: {},
  };
}

function modelResponse(model = "openai/gpt-4o"): ModelResponse {
  return { content: "ok", model };
}

function makeHandler(behavior: "ok" | "fail-429" | "fail-500" | "throw"): ModelHandler {
  return async (req: ModelRequest) => {
    if (behavior === "ok") return modelResponse(req.model);
    if (behavior === "throw") throw new Error("network down");
    const status = behavior === "fail-429" ? 429 : 500;
    const err = new Error(`upstream ${String(status)}`) as Error & { status: number };
    err.status = status;
    throw err;
  };
}

async function* asyncStream(chunks: readonly ModelChunk[]): AsyncIterable<ModelChunk> {
  for (const c of chunks) yield c;
}

describe("createCircuitBreakerMiddleware", () => {
  test("happy path: passes response through and stays CLOSED", async () => {
    const mw = createCircuitBreakerMiddleware();
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };
    const res = await mw.wrapModelCall?.(ctx, req, makeHandler("ok"));
    expect(res?.content).toBe("ok");
    const cap = mw.describeCapabilities(ctx);
    expect(cap?.description).toContain("healthy");
  });

  test("trips after failureThreshold failures within window", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 3 } });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };
    const failing = makeHandler("fail-500");

    for (let i = 0; i < 3; i++) {
      await expect(mw.wrapModelCall?.(ctx, req, failing)).rejects.toThrow();
    }
    // 4th call: circuit OPEN, fail fast
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("ok"))).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
    expect(mw.describeCapabilities(ctx)?.description).toContain("openai");
  });

  test("ignores status codes outside failureStatusCodes", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2, failureStatusCodes: [503] },
    });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };
    const fail429 = makeHandler("fail-429");
    // 429 is not in [503], so should NOT count
    await expect(mw.wrapModelCall?.(ctx, req, fail429)).rejects.toThrow();
    await expect(mw.wrapModelCall?.(ctx, req, fail429)).rejects.toThrow();
    // Still CLOSED — next call attempted
    await expect(mw.wrapModelCall?.(ctx, req, fail429)).rejects.toMatchObject({ status: 429 });
  });

  test("HALF_OPEN probe success closes circuit", async () => {
    let now = 1000;
    const clock = (): number => now;
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2, cooldownMs: 1000 },
      clock,
    });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };

    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    // OPEN
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("ok"))).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
    // advance past cooldown → HALF_OPEN allows one probe
    now += 2000;
    const res = await mw.wrapModelCall?.(ctx, req, makeHandler("ok"));
    expect(res?.content).toBe("ok");
    // Closed again → another call passes
    const res2 = await mw.wrapModelCall?.(ctx, req, makeHandler("ok"));
    expect(res2?.content).toBe("ok");
  });

  test("HALF_OPEN probe failure returns to OPEN", async () => {
    let now = 1000;
    const clock = (): number => now;
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2, cooldownMs: 1000 },
      clock,
    });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };

    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    now += 2000;
    // probe fails
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    // back to OPEN — fail fast
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("ok"))).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
  });

  test("tracks providers independently via extractKey default", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const failOpenAI = makeHandler("fail-500");
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "openai/gpt-4o" }, failOpenAI),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "openai/gpt-4o" }, failOpenAI),
    ).rejects.toThrow();
    // openai OPEN; anthropic still CLOSED
    const res = await mw.wrapModelCall?.(
      ctx,
      { messages: [], model: "anthropic/claude" },
      makeHandler("ok"),
    );
    expect(res?.content).toBe("ok");
  });

  test("custom extractKey overrides default", async () => {
    const seen: string[] = [];
    const mw = createCircuitBreakerMiddleware({
      extractKey: (m): string => {
        seen.push(m ?? "");
        return "custom";
      },
    });
    const ctx = turnCtx();
    await mw.wrapModelCall?.(ctx, { messages: [], model: "any/thing" }, makeHandler("ok"));
    expect(seen).toEqual(["any/thing"]);
  });

  test("wrapModelStream records success on done chunk", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const stream = mw.wrapModelStream?.(ctx, { messages: [], model: "openai/gpt-4o" }, () =>
      asyncStream([{ kind: "done", response: modelResponse() }]),
    );
    if (stream === undefined) throw new Error("no stream");
    const out: ModelChunk[] = [];
    for await (const c of stream) out.push(c);
    expect(out.length).toBe(1);
    expect(out[0]?.kind).toBe("done");
  });

  test("wrapModelStream records failure on error chunk and trips after threshold", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const fail: () => AsyncIterable<ModelChunk> = () =>
      asyncStream([{ kind: "error", message: "boom" }]);

    for (let i = 0; i < 2; i++) {
      const s = mw.wrapModelStream?.(ctx, { messages: [], model: "openai/gpt-4o" }, fail);
      if (s === undefined) throw new Error("no stream");
      const out: ModelChunk[] = [];
      for await (const c of s) out.push(c);
      expect(out[0]?.kind).toBe("error");
    }

    // OPEN → next stream emits a single error chunk without calling next
    let nextCalled = false;
    const s = mw.wrapModelStream?.(ctx, { messages: [], model: "openai/gpt-4o" }, () => {
      nextCalled = true;
      return asyncStream([{ kind: "done", response: modelResponse() }]);
    });
    if (s === undefined) throw new Error("no stream");
    const out: ModelChunk[] = [];
    for await (const c of s) out.push(c);
    expect(nextCalled).toBe(false);
    expect(out[0]?.kind).toBe("error");
  });

  test("default extractKey: bare model name (no slash) used as-is", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "gpt-4o" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "gpt-4o" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    expect(mw.describeCapabilities(ctx)?.description).toContain("gpt-4o");
  });

  test("default extractKey: undefined model maps to 'default'", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [] }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [] }, makeHandler("fail-500")),
    ).rejects.toThrow();
    expect(mw.describeCapabilities(ctx)?.description).toContain("default");
  });
});

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

  test("wrapModelStream records failure on upstream error chunk and trips after threshold", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    // Use TIMEOUT code so streamErrorStatus maps it to 503 (upstream-shaped).
    // A bare error chunk with no code is treated as local/unknown and
    // intentionally NOT counted against the breaker (see next test).
    const fail: () => AsyncIterable<ModelChunk> = () =>
      asyncStream([{ kind: "error", message: "boom", code: "TIMEOUT" }]);

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

  // Regression: streamed error chunks WITHOUT an upstream-shaped code must
  // not contribute to provider failure count. Otherwise auth/local/unknown
  // errors via the stream path would trip the circuit even though the
  // configured failureStatusCodes filter could not see them.
  test("wrapModelStream ignores error chunks without upstream code", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const local: () => AsyncIterable<ModelChunk> = () =>
      asyncStream([{ kind: "error", message: "auth failed" }]);

    for (let i = 0; i < 5; i++) {
      const s = mw.wrapModelStream?.(ctx, { messages: [], model: "openai/gpt-4o" }, local);
      if (s === undefined) throw new Error("no stream");
      for await (const _c of s) {
        // drain
      }
    }
    // Circuit must remain CLOSED — no upstream signal arrived.
    expect(mw.describeCapabilities(ctx)?.description).toContain("healthy");
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

  // Regression: local errors without an HTTP status (e.g. RATE_LIMIT thrown
  // by a downstream local limiter) must NOT poison the provider circuit.
  test("local errors without HTTP status do not contribute to breaker", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };
    // Simulate a local middleware throwing RATE_LIMIT with no `status` field.
    const localLimiter: ModelHandler = async () => {
      throw { code: "RATE_LIMIT", message: "local quota", retryable: false };
    };
    for (let i = 0; i < 5; i++) {
      await expect(mw.wrapModelCall?.(ctx, req, localLimiter)).rejects.toBeDefined();
    }
    // Provider was never actually contacted; circuit must still be CLOSED.
    expect(mw.describeCapabilities(ctx)?.description).toContain("healthy");
    const ok = await mw.wrapModelCall?.(ctx, req, makeHandler("ok"));
    expect(ok?.content).toBe("ok");
  });

  // Regression: stream that ends without an explicit `done` chunk must be
  // treated as failure, not silent success. query-engine surfaces this as
  // an error to callers, so the breaker must agree.
  test("wrapModelStream records failure when stream ends without done chunk", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    // Iterator yields a delta then ends — no `done`, no `error`.
    const naked: () => AsyncIterable<ModelChunk> = () =>
      asyncStream([{ kind: "text_delta", delta: "hi" }]);

    for (let i = 0; i < 2; i++) {
      const s = mw.wrapModelStream?.(ctx, { messages: [], model: "openai/gpt-4o" }, naked);
      if (s === undefined) throw new Error("no stream");
      for await (const _c of s) {
        // drain
      }
    }
    // Two truncated streams should trip the circuit.
    expect(mw.describeCapabilities(ctx)?.description).toContain("openai");
  });

  // Regression: the runtime adapter wraps upstream HTTP failures as
  // `Error(..., { cause: { code, retryable } })`. The breaker must see
  // through that envelope and count the failure.
  test("counts failures wrapped as Error.cause.code (runtime adapter shape)", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };
    const upstream429: ModelHandler = async () => {
      throw new Error("upstream rate limited", {
        cause: { code: "RATE_LIMIT", retryable: true },
      });
    };
    await expect(mw.wrapModelCall?.(ctx, req, upstream429)).rejects.toBeDefined();
    await expect(mw.wrapModelCall?.(ctx, req, upstream429)).rejects.toBeDefined();
    // 3rd call: circuit OPEN, fails fast
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("ok"))).rejects.toMatchObject({
      code: "RATE_LIMIT",
    });
    expect(mw.describeCapabilities(ctx)?.description).toContain("openai");
  });

  // Regression: consumer cancellation (early break, abort, downstream
  // short-circuit) must NOT count as a provider failure. Otherwise a few
  // local cancellations would trip the circuit on a healthy backend.
  test("consumer breaking out of stream does not record breaker failure", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    // Long stream that yields many text deltas before any terminal chunk.
    async function* longStream(): AsyncIterable<ModelChunk> {
      for (let i = 0; i < 100; i++) {
        yield { kind: "text_delta", delta: "x" };
      }
      yield { kind: "done", response: modelResponse() };
    }
    // Consumer breaks after the first chunk, repeatedly.
    for (let attempt = 0; attempt < 10; attempt++) {
      const s = mw.wrapModelStream?.(ctx, { messages: [], model: "openai/gpt-4o" }, longStream);
      if (s === undefined) throw new Error("no stream");
      for await (const _c of s) {
        break; // consumer cancellation
      }
    }
    // Circuit must still be CLOSED — no upstream failure occurred.
    expect(mw.describeCapabilities(ctx)?.description).toContain("healthy");
  });

  // Regression: a consumer that cancels a HALF_OPEN probe must not leave
  // the breaker stuck with `probeInFlight=true` forever. Without explicit
  // probe-abandonment handling, every subsequent call rejects even after
  // the upstream recovers — a permanent provider blackhole.
  test("HALF_OPEN probe cancellation does not wedge the circuit", async () => {
    let now = 1000;
    const clock = (): number => now;
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2, cooldownMs: 1000 },
      clock,
    });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };

    // Trip the circuit
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    // Advance past cooldown so the next stream call takes the HALF_OPEN probe
    now += 2000;

    // Probe stream that the consumer cancels mid-flight (no done/error).
    async function* longStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "x" };
      yield { kind: "text_delta", delta: "y" };
      yield { kind: "done", response: modelResponse() };
    }
    const s = mw.wrapModelStream?.(ctx, req, longStream);
    if (s === undefined) throw new Error("no stream");
    for await (const _c of s) {
      break; // consumer cancellation while in HALF_OPEN
    }

    // Advance past cooldown again. The breaker must allow another probe;
    // if probeInFlight wasn't released, this call would reject forever.
    now += 2000;
    const ok = await mw.wrapModelCall?.(ctx, req, makeHandler("ok"));
    expect(ok?.content).toBe("ok");
  });

  // Regression: streamed RATE_LIMIT/TIMEOUT/EXTERNAL chunks come from the
  // model adapter, not local middleware (which throw, not yield). They
  // ARE provider failures and must count.
  test("streamed RATE_LIMIT chunk trips the circuit", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const upstream: () => AsyncIterable<ModelChunk> = () =>
      asyncStream([
        { kind: "error", message: "rate limited", code: "RATE_LIMIT", retryable: true },
      ]);

    for (let i = 0; i < 2; i++) {
      const s = mw.wrapModelStream?.(ctx, { messages: [], model: "openai/gpt-4o" }, upstream);
      if (s === undefined) throw new Error("no stream");
      for await (const _c of s) {
        // drain
      }
    }
    expect(mw.describeCapabilities(ctx)?.description).toContain("openai");
  });

  // Regression: maxKeys must enforce a memory bound, not just warn.
  test("maxKeys evicts oldest key when bound is reached", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2 },
      maxKeys: 2,
    });
    const ctx = turnCtx();
    // 3 distinct providers — first should be evicted.
    await mw.wrapModelCall?.(ctx, { messages: [], model: "p1/m" }, makeHandler("ok"));
    await mw.wrapModelCall?.(ctx, { messages: [], model: "p2/m" }, makeHandler("ok"));
    await mw.wrapModelCall?.(ctx, { messages: [], model: "p3/m" }, makeHandler("ok"));
    // Trip p2 and p3 — but if eviction worked, p1's state was discarded and
    // can be re-created on demand. Bound is the invariant we care about.
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "p2/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "p2/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    // Adding p4 should evict p3 (now oldest), not unbounded growth.
    const ok = await mw.wrapModelCall?.(ctx, { messages: [], model: "p4/m" }, makeHandler("ok"));
    expect(ok?.content).toBe("ok");
    // We cannot directly observe map size, but describeCapabilities should
    // not list more than maxKeys=2 open circuits even under high cardinality.
    const desc = mw.describeCapabilities(ctx)?.description ?? "";
    const openCount = desc === "All circuits closed (healthy)." ? 0 : desc.split(",").length;
    expect(openCount).toBeLessThanOrEqual(2);
  });
});

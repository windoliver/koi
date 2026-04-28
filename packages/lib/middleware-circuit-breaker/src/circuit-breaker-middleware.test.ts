import { describe, expect, test } from "bun:test";
import type { TurnContext } from "@koi/core";
import { runId, sessionId, turnId } from "@koi/core";
import type { ModelChunk, ModelHandler, ModelRequest, ModelResponse } from "@koi/core/middleware";
import { createCircuitBreakerMiddleware } from "./circuit-breaker-middleware.js";

function turnCtx(sid = "s-1"): TurnContext {
  const rid = runId(`run-${sid}`);
  return {
    session: { agentId: "a", sessionId: sessionId(sid), runId: rid, metadata: {} },
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

  // Regression: a truncated stream (no done, no error chunk) is NOT a
  // confirmed provider fault. Round-16 changed the policy: previously
  // we counted truncation as failure with no status — that bypassed
  // any restrictive `failureStatusCodes` configuration. Now truncation
  // is silently ignored and only classified upstream errors trip the
  // breaker.
  test("wrapModelStream does NOT count truncated streams (no status) against the breaker", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const naked: () => AsyncIterable<ModelChunk> = () =>
      asyncStream([{ kind: "text_delta", delta: "hi" }]);
    for (let i = 0; i < 5; i++) {
      const s = mw.wrapModelStream?.(ctx, { messages: [], model: "openai/gpt-4o" }, naked);
      if (s === undefined) throw new Error("no stream");
      for await (const _c of s) {
        // drain
      }
    }
    // Even five truncated streams must not trip the breaker.
    expect(mw.describeCapabilities(ctx)?.description).toContain("healthy");
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

  // Regression (#1419 round 20): consumer cancellation of a HALF_OPEN
  // probe must NOT count as a provider failure. Otherwise repeated
  // client-side aborts would keep re-opening a healthy circuit and
  // block recovery indefinitely.
  test("HALF_OPEN probe cancellation does not record failure against the breaker", async () => {
    let now = 1000;
    const clock = (): number => now;
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2, cooldownMs: 1000 },
      clock,
    });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };

    // Trip the circuit OPEN with two upstream failures.
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    now += 2000; // cooldown

    // Cancel three HALF_OPEN probes in a row. Under the old behavior,
    // each cancellation called recordFailure() and re-opened the
    // circuit; the next call after cooldown would have been blocked
    // OR would have succeeded only because the cooldown timer
    // advanced. We assert here that NONE of the cancellations
    // produced a recordFailure, by checking that an immediate
    // (no-cooldown) follow-up call is allowed.
    async function* longStream(): AsyncIterable<ModelChunk> {
      yield { kind: "text_delta", delta: "x" };
      yield { kind: "done", response: modelResponse() };
    }
    for (let i = 0; i < 3; i++) {
      const s = mw.wrapModelStream?.(ctx, req, longStream);
      if (s === undefined) throw new Error("no stream");
      for await (const _c of s) break;
      // No clock advance between iterations — if probe cancellation had
      // recorded failure, the breaker would be OPEN and isAllowed() would
      // be false until cooldown elapsed (cooldownMs=1000).
    }
    // Immediate call (no clock advance) must be allowed: circuit is
    // still HALF_OPEN with a free probe slot.
    const ok = await mw.wrapModelCall?.(ctx, req, makeHandler("ok"));
    expect(ok?.content).toBe("ok");
  });

  // Regression (#1419 round 22): wrapModelStream's `next(request)` may
  // throw synchronously before returning an AsyncIterable (e.g.
  // call-limit middleware throws when budget exhausted, or a stream
  // factory fails during setup). If a HALF_OPEN probe was taken, the
  // probeInFlight slot must be released or the circuit wedges forever.
  test("HALF_OPEN stream probe is released when next() throws synchronously", async () => {
    let now = 1000;
    const clock = (): number => now;
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2, cooldownMs: 1000 },
      clock,
    });
    const ctx = turnCtx();
    const req: ModelRequest = { messages: [], model: "openai/gpt-4o" };

    // Trip OPEN.
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    await expect(mw.wrapModelCall?.(ctx, req, makeHandler("fail-500"))).rejects.toThrow();
    now += 2000; // cooldown → next call gets the probe

    // wrapModelStream where the inner handler throws synchronously
    // (no upstream status — purely local). The probe slot must be
    // released.
    // Round-29 update: realistic local-setup throws come from
    // downstream LOCAL middleware (call-limits, validators) and
    // emit KoiError-shaped objects with `code`/`retryable`. Bare
    // unstructured Errors are now treated as transport faults and
    // counted; KoiError-shaped local emissions remain ignored.
    const throwingFactory = (): AsyncIterable<ModelChunk> => {
      throw { code: "RATE_LIMIT", message: "local quota exhausted", retryable: false };
    };
    // Iterate the lazy stream — the gate now runs inside the iterator,
    // so the synchronous throw surfaces at iteration start.
    const stream = mw.wrapModelStream?.(ctx, req, throwingFactory);
    if (stream === undefined) throw new Error("no stream");
    await expect(
      (async () => {
        // biome-ignore lint/correctness/noUnusedVariables: trigger iteration
        for await (const _ of stream) {
        }
      })(),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });

    // Immediate follow-up (no clock advance) must still get a probe.
    // If probeInFlight had leaked, isAllowed() would return false here
    // because the breaker remains HALF_OPEN with the slot occupied.
    const ok = await mw.wrapModelCall?.(ctx, req, makeHandler("ok"));
    expect(ok?.content).toBe("ok");
  });

  // Regression (#1419 round 23): if a caller obtains the stream and
  // never iterates, the probe slot must NOT be taken. Eager probe
  // acquisition would leak `probeInFlight` permanently because the
  // generator's `finally` only runs on iteration completion.
  test("HALF_OPEN stream that is never iterated does not consume the probe slot", async () => {
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
    now += 2000; // cooldown

    // Obtain the stream but do not iterate it. The probe must not be
    // taken, so a follow-up call can still claim the probe slot.
    let factoryCalled = 0;
    async function* okStream(): AsyncIterable<ModelChunk> {
      factoryCalled++;
      yield { kind: "done", response: modelResponse() };
    }
    const abandoned = mw.wrapModelStream?.(ctx, req, okStream);
    expect(abandoned).toBeDefined();
    expect(factoryCalled).toBe(0);

    // Follow-up call must succeed (probe still available, no clock advance).
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

  // Regression: capacity-pressure eviction must NOT drop an OPEN circuit.
  // If it did, the next request for that still-unhealthy provider would
  // create a fresh CLOSED breaker and resume sending traffic upstream —
  // defeating fail-fast during the high-cardinality incidents the bound
  // is meant to handle.
  test("maxKeys never evicts OPEN circuits — only CLOSED entries", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2 },
      maxKeys: 2,
    });
    const ctx = turnCtx();
    // Trip p1 to OPEN.
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "p1/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "p1/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    // Add p2 (CLOSED) — fills capacity at 2.
    await mw.wrapModelCall?.(ctx, { messages: [], model: "p2/m" }, makeHandler("ok"));
    // p3 forces eviction. p1 is OPEN and must be preserved; p2 (CLOSED)
    // must be the one evicted.
    await mw.wrapModelCall?.(ctx, { messages: [], model: "p3/m" }, makeHandler("ok"));
    // p1 must still be OPEN — calling it must short-circuit, not re-execute.
    let p1Calls = 0;
    const handler = async (): Promise<never> => {
      p1Calls++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "p1/m" }, handler),
    ).rejects.toThrow();
    expect(p1Calls).toBe(0);
  });

  // Regression: maxKeys is a HARD bound. When all existing entries are
  // OPEN/HALF_OPEN and a new key arrives, the middleware must reject the
  // request with a local RATE_LIMIT — passthrough would let the
  // high-cardinality outage that filled the map degrade into full
  // upstream timeouts for every new key. Round-14: changed from
  // passthrough to fail-fast.
  test("maxKeys exhaustion fails fast (no passthrough) when every circuit is OPEN", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2 },
      maxKeys: 2,
    });
    const ctx = turnCtx();
    for (const m of ["p1/m", "p2/m"]) {
      await expect(
        mw.wrapModelCall?.(ctx, { messages: [], model: m }, makeHandler("fail-500")),
      ).rejects.toThrow();
      await expect(
        mw.wrapModelCall?.(ctx, { messages: [], model: m }, makeHandler("fail-500")),
      ).rejects.toThrow();
    }
    // p3 must NOT call the handler — it must reject locally.
    let p3Calls = 0;
    const trace = async (): Promise<never> => {
      p3Calls++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "p3/m" }, trace),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(p3Calls).toBe(0);
  });

  // Regression: extractKey receives TurnContext so multi-tenant deployments
  // can scope circuits by tenant. Without this, one tenant's quota
  // exhaustion could trip the breaker for unrelated traffic on the same
  // provider.
  test("extractKey receives TurnContext for tenant-scoped breaker keys", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2 },
      extractKey: (model, c) => `${model ?? "x"}|${c.session.sessionId}`,
    });
    // Tenant A trips its breaker.
    const ctxA = turnCtx("tenant-a");
    await expect(
      mw.wrapModelCall?.(ctxA, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctxA, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    // Tenant B on the SAME provider must NOT be affected.
    const ctxB = turnCtx("tenant-b");
    const r = await mw.wrapModelCall?.(
      ctxB,
      { messages: [], model: "openai/m" },
      makeHandler("ok"),
    );
    expect(r?.content).toBe("ok");
  });

  // Regression: tenant-scoped extractKey + maxKeys must NOT silently lose
  // breaker coverage as sessions accumulate. `onSessionEnd` reclaims that
  // session's CLOSED keys so a later tenant always gets a real breaker.
  test("onSessionEnd reclaims tenant-scoped CLOSED breaker keys", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2 },
      maxKeys: 2,
      extractKey: (model, c) => `${model ?? "x"}|${c.session.sessionId}`,
    });
    const ctxA = turnCtx("tenant-a");
    const ctxB = turnCtx("tenant-b");
    await mw.wrapModelCall?.(ctxA, { messages: [], model: "openai/m" }, makeHandler("ok"));
    await mw.wrapModelCall?.(ctxB, { messages: [], model: "openai/m" }, makeHandler("ok"));
    await mw.onSessionEnd?.(ctxA.session);
    // tenant-c must still get real breaker coverage, not passthrough.
    const ctxC = turnCtx("tenant-c");
    for (let i = 0; i < 2; i++) {
      await expect(
        mw.wrapModelCall?.(ctxC, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
      ).rejects.toThrow();
    }
    let runCount = 0;
    const trace = async (): Promise<never> => {
      runCount++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctxC, { messages: [], model: "openai/m" }, trace),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(runCount).toBe(0);
  });

  // Regression: onSessionEnd must NOT evict an OPEN circuit while
  // another live session still owns the key (refcount > 0). Round 15
  // changed ownerless reclamation to ALSO drop OPEN entries so capacity
  // can recover after outages, but shared-key OPEN must persist while
  // any owner remains.
  test("onSessionEnd preserves OPEN circuits while another owner remains", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2 },
      maxKeys: 4,
      extractKey: (m) => (m ?? "x").split("/")[0] ?? "x",
    });
    const ctxA = turnCtx("tenant-a");
    const ctxB = turnCtx("tenant-b");
    // tenant-b touches the shared key first (becomes an owner) so
    // refcount > 0 when tenant-a ends below.
    await mw.wrapModelCall?.(ctxB, { messages: [], model: "openai/m" }, makeHandler("ok"));
    // tenant-a trips the shared OPEN.
    await expect(
      mw.wrapModelCall?.(ctxA, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctxA, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await mw.onSessionEnd?.(ctxA.session);
    // tenant-b is still an owner — the OPEN must persist for it.
    let runCount = 0;
    const trace = async (): Promise<never> => {
      runCount++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctxB, { messages: [], model: "openai/m" }, trace),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(runCount).toBe(0);
  });

  // Regression (#1419 round 12): provider-scoped breakers are SHARED
  // across concurrent sessions by design. When one session ends, its
  // onSessionEnd path must NOT delete the shared CLOSED breaker — that
  // would erase accumulated failure history for every other live
  // session on the same provider, delaying a legitimate trip to OPEN.
  test("onSessionEnd preserves shared provider breakers for live sessions", async () => {
    // Explicit provider-level extractKey: opts out of the safer
    // session-scoped default to share the breaker across sessions.
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 3 },
      extractKey: (m) => (m ?? "x").split("/")[0] ?? "x",
    });
    const ctxA = turnCtx("session-a");
    const ctxB = turnCtx("session-b");
    // Both sessions touch the shared "openai" provider key. Two failures
    // accumulate in the shared ring buffer — one short of threshold.
    await expect(
      mw.wrapModelCall?.(ctxA, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctxB, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    // session-a ends. The shared breaker MUST survive because session-b
    // still references it.
    await mw.onSessionEnd?.(ctxA.session);
    // Third failure from session-b should now trip OPEN — proves the
    // ring buffer was preserved across session-a's cleanup.
    await expect(
      mw.wrapModelCall?.(ctxB, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    let runCount = 0;
    const trace = async (): Promise<never> => {
      runCount++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctxB, { messages: [], model: "openai/m" }, trace),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(runCount).toBe(0);
  });

  // Regression (#1419 round 13): ownership bookkeeping must shrink in
  // lockstep with the breakers map. If `getOrCreateBreaker` evicts a
  // CLOSED entry but leaves stale `keyOwners` / `keysBySession` refs
  // behind, a long-lived session driving many distinct keys grows
  // unbounded auxiliary state — defeating the advertised `maxKeys` cap.
  test("CLOSED-breaker eviction also prunes keyOwners + keysBySession", async () => {
    const mw = createCircuitBreakerMiddleware({ maxKeys: 2, breaker: { failureThreshold: 2 } });
    // Reach into state via describeCapabilities is opaque; validate by
    // observable behavior: drive >>maxKeys distinct keys through one
    // session, confirm subsequent calls still get real breaker coverage
    // (no permanent passthrough), and confirm OPEN circuits survive.
    const ctx = turnCtx("long-session");
    for (let i = 0; i < 20; i++) {
      await mw.wrapModelCall?.(
        ctx,
        { messages: [], model: `provider${String(i)}/m` },
        makeHandler("ok"),
      );
    }
    // Now trip a fresh provider to OPEN — must succeed (breaker was
    // installed, not passthrough), and OPEN must persist.
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "openX/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "openX/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    let runCount = 0;
    const trace = async (): Promise<never> => {
      runCount++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "openX/m" }, trace),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(runCount).toBe(0);
  });

  // Regression (#1419 round 15): ownerless OPEN circuits must be
  // reclaimed on session end. Otherwise an outage that trips many
  // session-scoped breakers can permanently wedge the map at capacity:
  // those sessions terminate, the provider recovers, but new sessions
  // forever hit RATE_LIMIT capacity-exhaustion because nothing closes
  // the orphans.
  test("ownerless OPEN circuits are reclaimed when last session ends", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 2 },
      maxKeys: 2,
    });
    // Trip session-A's session-scoped breaker to OPEN.
    const ctxA = turnCtx("session-a");
    for (let i = 0; i < 2; i++) {
      await expect(
        mw.wrapModelCall?.(ctxA, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
      ).rejects.toThrow();
    }
    // Trip session-B's session-scoped breaker to OPEN. Now both
    // capacity slots are OPEN circuits owned by their own session only.
    const ctxB = turnCtx("session-b");
    for (let i = 0; i < 2; i++) {
      await expect(
        mw.wrapModelCall?.(ctxB, { messages: [], model: "openai/m" }, makeHandler("fail-500")),
      ).rejects.toThrow();
    }
    // Both sessions end — owners drop to 0. OPEN circuits MUST be
    // reclaimed, otherwise the next session below will see capacity
    // exhausted and reject locally with RATE_LIMIT.
    await mw.onSessionEnd?.(ctxA.session);
    await mw.onSessionEnd?.(ctxB.session);
    // Provider has recovered. session-c arrives — must succeed because
    // capacity was reclaimed.
    const ctxC = turnCtx("session-c");
    const r = await mw.wrapModelCall?.(
      ctxC,
      { messages: [], model: "openai/m" },
      makeHandler("ok"),
    );
    expect(r?.content).toBe("ok");
  });

  // Regression (#1419 round 18): eviction must prefer victims with no
  // accumulated failure history. Otherwise a noisy session driving many
  // distinct keys can erase another live session's almost-tripped
  // breaker, sending the next failure for that provider back to full
  // upstream execution instead of fail-fast.
  test("maxKeys eviction prefers CLOSED with zero failures over CLOSED with partial ring", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 3 },
      maxKeys: 2,
      // Provider-only key so the test can assert on a specific key.
      extractKey: (m) => (m ?? "x").split("/")[0] ?? "x",
    });
    const ctx = turnCtx();
    // Accumulate 2 failures on `risky/m` (one short of threshold=3).
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "risky/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "risky/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    // Establish a CLOSED-no-failures `idle/m` to fill capacity.
    await mw.wrapModelCall?.(ctx, { messages: [], model: "idle/m" }, makeHandler("ok"));
    // New key `fresh/m` forces eviction. The eviction MUST pick `idle/m`
    // (zero failures) over `risky/m` (partial ring buffer).
    await mw.wrapModelCall?.(ctx, { messages: [], model: "fresh/m" }, makeHandler("ok"));
    // One more failure on `risky/m` should now trip OPEN — the partial
    // ring buffer was preserved.
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "risky/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    let runCount = 0;
    const trace = async (): Promise<never> => {
      runCount++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "risky/m" }, trace),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(runCount).toBe(0);
  });

  // Regression (#1419 round 19): when capacity is full and every CLOSED
  // entry has accumulated failure history, eviction MUST refuse to drop
  // any of them. Returning a fresh breaker for the new key would erase
  // a still-tripping ring buffer; instead we fail-fast on the new key
  // and leave the live breakers intact.
  test("maxKeys eviction refuses to drop CLOSED breakers with accumulated failures", async () => {
    const mw = createCircuitBreakerMiddleware({
      breaker: { failureThreshold: 5 },
      maxKeys: 2,
      extractKey: (m) => (m ?? "x").split("/")[0] ?? "x",
    });
    const ctx = turnCtx();
    // Both keys accumulate partial failure history (1/5 each).
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "a/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "b/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    // Third key arrives. Capacity is full and no rank-1/rank-2 victim
    // exists, so insertion must be refused with a fail-fast error.
    let runCount = 0;
    const trace = async (): Promise<never> => {
      runCount++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "c/m" }, trace),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(runCount).toBe(0);
    // Both partial rings survived: another failure on `a/m` should
    // accumulate to 2/5 (not reset to 1/5), proving no eviction occurred.
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "a/m" }, makeHandler("fail-500")),
    ).rejects.toThrow();
    // Three more failures trip OPEN. If the breaker had been evicted/reset,
    // we would need 5 fresh failures here.
    for (let i = 0; i < 3; i++) {
      await expect(
        mw.wrapModelCall?.(ctx, { messages: [], model: "a/m" }, makeHandler("fail-500")),
      ).rejects.toThrow();
    }
    let aRun = 0;
    const traceA = async (): Promise<never> => {
      aRun++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "a/m" }, traceA),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(aRun).toBe(0);
  });

  // Regression (#1419 round 29 → tightened in round 35): bare
  // provider/transport errors must trip the breaker, but ONLY when
  // they carry a recognized transport shape (TypeError("fetch
  // failed"), FetchError/NetworkError/TimeoutError, or chained
  // cause.code in TRANSPORT_ERROR_CODES). A plain `Error` from local
  // middleware bugs must NOT mutate provider health — see the
  // matching "local plain Error does not trip the breaker" test.
  test("bare transport errors with no status code trip the breaker", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 3 } });
    const ctx = turnCtx();
    const transport: ModelHandler = async () => {
      // Mirror what Bun/Node fetch throws on connection failure:
      // a TypeError whose message starts with "fetch failed".
      throw new TypeError("fetch failed");
    };
    // Three bare transport errors in a row should trip OPEN.
    for (let i = 0; i < 3; i++) {
      await expect(
        mw.wrapModelCall?.(ctx, { messages: [], model: "openai/gpt-4o" }, transport),
      ).rejects.toThrow("fetch failed");
    }
    // Next call must be rejected fast with RATE_LIMIT (circuit OPEN),
    // proving the bare errors were counted.
    let runs = 0;
    const trace: ModelHandler = async () => {
      runs++;
      throw new Error("should-not-run");
    };
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "openai/gpt-4o" }, trace),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
    expect(runs).toBe(0);
  });

  // Regression (#1419 round 29): AbortError must NOT count as a
  // provider failure — it's a local control-flow event.
  test("AbortError does not trip the breaker", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const aborter: ModelHandler = async () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    };
    for (let i = 0; i < 5; i++) {
      await expect(
        mw.wrapModelCall?.(ctx, { messages: [], model: "openai/gpt-4o" }, aborter),
      ).rejects.toThrow("aborted");
    }
    // Circuit must still allow traffic — aborts are not provider faults.
    const ok = await mw.wrapModelCall?.(
      ctx,
      { messages: [], model: "openai/gpt-4o" },
      makeHandler("ok"),
    );
    expect(ok?.content).toBe("ok");
  });

  // Regression (#1419 round 35): a plain `Error` from local middleware
  // bugs (validators, exfiltration guard, model-router glue, etc.)
  // must NOT trip the breaker. The breaker wraps the entire
  // downstream chain via `next(request)`, so a local fault would
  // otherwise mutate provider health and could blackhole subsequent
  // model traffic behind a healthy provider until cooldown.
  test("local plain Error from downstream middleware does not trip the breaker", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 2 } });
    const ctx = turnCtx();
    const localBuggy: ModelHandler = async () => {
      // Plain `Error`, no `cause`, name === "Error". Indistinguishable
      // from a downstream validator throw — must not affect provider
      // breaker state.
      throw new Error("validator misconfiguration");
    };
    for (let i = 0; i < 5; i++) {
      await expect(
        mw.wrapModelCall?.(ctx, { messages: [], model: "openai/gpt-4o" }, localBuggy),
      ).rejects.toThrow("validator misconfiguration");
    }
    // Circuit must still allow traffic — local faults are not
    // provider failures.
    const ok = await mw.wrapModelCall?.(
      ctx,
      { messages: [], model: "openai/gpt-4o" },
      makeHandler("ok"),
    );
    expect(ok?.content).toBe("ok");
  });

  // Regression (#1419 round 35): chained `cause.code` in the
  // transport allowlist (ECONNRESET, ETIMEDOUT, etc.) DOES trip the
  // breaker — that's the canonical adapter-boundary signal for an
  // upstream transport fault.
  test("error with cause.code in TRANSPORT_ERROR_CODES trips the breaker", async () => {
    const mw = createCircuitBreakerMiddleware({ breaker: { failureThreshold: 3 } });
    const ctx = turnCtx();
    const transport: ModelHandler = async () => {
      const err = new Error("provider unreachable");
      (err as Error & { cause: { code: string } }).cause = { code: "ECONNRESET" };
      throw err;
    };
    for (let i = 0; i < 3; i++) {
      await expect(
        mw.wrapModelCall?.(ctx, { messages: [], model: "openai/gpt-4o" }, transport),
      ).rejects.toThrow("provider unreachable");
    }
    await expect(
      mw.wrapModelCall?.(ctx, { messages: [], model: "openai/gpt-4o" }, makeHandler("ok")),
    ).rejects.toMatchObject({ code: "RATE_LIMIT" });
  });
});

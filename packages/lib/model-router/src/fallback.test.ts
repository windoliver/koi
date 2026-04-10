import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { createCircuitBreaker } from "@koi/errors";
import { type FallbackTarget, withFallback } from "./fallback.js";

function makeTarget(id: string, enabled = true): FallbackTarget {
  return { id, enabled };
}

function makeError(message: string): KoiError {
  return { code: "EXTERNAL", message, retryable: false };
}

describe("withFallback", () => {
  test("single target succeeds → returns result", async () => {
    const result = await withFallback([makeTarget("a")], () => Promise.resolve("ok"), new Map());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.value).toBe("ok");
    expect(result.value.targetIndex).toBe(0);
    expect(result.value.attempts).toHaveLength(1);
    expect(result.value.attempts[0]?.success).toBe(true);
  });

  test("single target fails → returns aggregated error", async () => {
    const result = await withFallback(
      [makeTarget("a")],
      () => {
        throw makeError("down");
      },
      new Map(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("down");
  });

  test("first target fails → second succeeds → returns second result", async () => {
    const result = await withFallback(
      [makeTarget("a"), makeTarget("b")],
      (t) => {
        if (t.id === "a") throw makeError("a-down");
        return Promise.resolve("from-b");
      },
      new Map(),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.value).toBe("from-b");
    expect(result.value.targetIndex).toBe(1);
    expect(result.value.attempts).toHaveLength(2);
    expect(result.value.attempts[0]?.success).toBe(false);
    expect(result.value.attempts[1]?.success).toBe(true);
  });

  test("all targets fail → error lists all failures", async () => {
    const result = await withFallback(
      [makeTarget("a"), makeTarget("b")],
      (t) => {
        throw makeError(`${t.id}-down`);
      },
      new Map(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.message).toContain("a-down");
    expect(result.error.message).toContain("b-down");
  });

  test("no enabled targets → returns validation error", async () => {
    const result = await withFallback(
      [makeTarget("a", false)],
      () => Promise.resolve("ok"),
      new Map(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error();
    expect(result.error.code).toBe("VALIDATION");
  });

  test("skips target with open circuit breaker", async () => {
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });
    cb.recordFailure(500); // opens the breaker

    const tried: string[] = [];
    const result = await withFallback(
      [makeTarget("a"), makeTarget("b")],
      (t) => {
        tried.push(t.id);
        return Promise.resolve("ok");
      },
      new Map([["a", cb]]),
    );

    expect(tried).toEqual(["b"]);
    expect(result.ok).toBe(true);
  });

  test("graceful degradation: if all circuit breakers open, tries them anyway", async () => {
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });
    cb.recordFailure(500);

    const tried: string[] = [];
    const result = await withFallback(
      [makeTarget("a")],
      (t) => {
        tried.push(t.id);
        return Promise.resolve("degraded");
      },
      new Map([["a", cb]]),
    );

    expect(tried).toEqual(["a"]);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.value).toBe("degraded");
  });

  test("records success in circuit breaker on success", async () => {
    const cb = createCircuitBreaker();
    const cbs = new Map([["a", cb]]);
    const before = cb.getSnapshot().failureCount;

    await withFallback([makeTarget("a")], () => Promise.resolve("ok"), cbs);

    // recordSuccess should keep CLOSED state
    expect(cb.getSnapshot().state).toBe("CLOSED");
    expect(cb.getSnapshot().failureCount).toBe(before);
  });

  test("records failure in circuit breaker on failure", async () => {
    const cb = createCircuitBreaker({
      failureThreshold: 5,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });
    const cbs = new Map([
      ["a", cb],
      ["b", createCircuitBreaker()],
    ]);

    await withFallback(
      [makeTarget("a"), makeTarget("b")],
      (t) => {
        if (t.id === "a") throw makeError("a-down");
        return Promise.resolve("ok");
      },
      cbs,
    );

    expect(cb.getSnapshot().failureCount).toBe(1);
  });

  test("timing: durationMs recorded per attempt", async () => {
    let t = 0;
    const clock = () => {
      t += 100;
      return t;
    };

    const result = await withFallback(
      [makeTarget("a")],
      () => Promise.resolve("ok"),
      new Map(),
      clock,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error();
    expect(result.value.attempts[0]?.durationMs).toBe(100);
  });
});

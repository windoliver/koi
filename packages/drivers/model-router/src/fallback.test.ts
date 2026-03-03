import { describe, expect, test } from "bun:test";
import type { KoiError } from "@koi/core";
import { createCircuitBreaker } from "./circuit-breaker.js";
import { type FallbackTarget, withFallback } from "./fallback.js";

function makeTarget(id: string, enabled = true): FallbackTarget {
  return { id, enabled };
}

function makeError(message: string): KoiError {
  return { code: "EXTERNAL", message, retryable: false };
}

describe("withFallback", () => {
  test("single target succeeds → returns result", async () => {
    const targets = [makeTarget("a")];
    const result = await withFallback(targets, () => Promise.resolve("ok"), new Map());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.value).toBe("ok");
    expect(result.value.targetIndex).toBe(0);
    expect(result.value.attempts).toHaveLength(1);
    expect(result.value.attempts[0]?.success).toBe(true);
  });

  test("single target fails → returns error", async () => {
    const targets = [makeTarget("a")];
    const result = await withFallback(
      targets,
      () => {
        throw makeError("provider down");
      },
      new Map(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("EXTERNAL");
    expect(result.error.message).toContain("provider down");
  });

  test("first target fails → second succeeds", async () => {
    const targets = [makeTarget("a"), makeTarget("b")];
    let callCount = 0;

    const result = await withFallback(
      targets,
      (target) => {
        callCount++;
        if (target.id === "a") throw makeError("a failed");
        return Promise.resolve("from-b");
      },
      new Map(),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.value).toBe("from-b");
    expect(result.value.targetIndex).toBe(1);
    expect(result.value.attempts).toHaveLength(2);
    expect(callCount).toBe(2);
  });

  test("first succeeds → second never called", async () => {
    const targets = [makeTarget("a"), makeTarget("b")];
    const called: string[] = [];

    const result = await withFallback(
      targets,
      (target) => {
        called.push(target.id);
        return Promise.resolve("from-a");
      },
      new Map(),
    );

    expect(result.ok).toBe(true);
    expect(called).toEqual(["a"]);
  });

  test("all targets fail → aggregated error", async () => {
    const targets = [makeTarget("a"), makeTarget("b"), makeTarget("c")];

    const result = await withFallback(
      targets,
      (target) => {
        throw makeError(`${target.id} failed`);
      },
      new Map(),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.message).toContain("3 targets failed");
    expect(result.error.message).toContain("a failed");
    expect(result.error.message).toContain("b failed");
    expect(result.error.message).toContain("c failed");
  });

  test("disabled targets are skipped", async () => {
    const targets = [makeTarget("a", false), makeTarget("b", true)];
    const called: string[] = [];

    const result = await withFallback(
      targets,
      (target) => {
        called.push(target.id);
        return Promise.resolve("from-b");
      },
      new Map(),
    );

    expect(result.ok).toBe(true);
    expect(called).toEqual(["b"]);
  });

  test("targets with OPEN circuit breaker are skipped", async () => {
    const targets = [makeTarget("a"), makeTarget("b")];
    const cb = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });
    cb.recordFailure(500); // → OPEN
    expect(cb.getSnapshot().state).toBe("OPEN");

    const breakers = new Map([["a", cb]]);
    const called: string[] = [];

    const result = await withFallback(
      targets,
      (target) => {
        called.push(target.id);
        return Promise.resolve("from-b");
      },
      breakers,
    );

    expect(result.ok).toBe(true);
    expect(called).toEqual(["b"]);
  });

  test("all circuit breakers OPEN → bypasses breakers (graceful degradation)", async () => {
    const targets = [makeTarget("a"), makeTarget("b")];
    const cbA = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });
    const cbB = createCircuitBreaker({
      failureThreshold: 1,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });
    cbA.recordFailure(500);
    cbB.recordFailure(500);

    const breakers = new Map([
      ["a", cbA],
      ["b", cbB],
    ]);
    const called: string[] = [];

    const result = await withFallback(
      targets,
      (target) => {
        called.push(target.id);
        if (target.id === "a") throw makeError("still down");
        return Promise.resolve("b recovered");
      },
      breakers,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.value).toBe("b recovered");
    // Both should be tried since all breakers were bypassed
    expect(called).toEqual(["a", "b"]);
  });

  test("no enabled targets → VALIDATION error", async () => {
    const targets = [makeTarget("a", false), makeTarget("b", false)];

    const result = await withFallback(targets, () => Promise.resolve("never"), new Map());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
    expect(result.error.message).toContain("No enabled targets");
  });

  test("empty targets → VALIDATION error", async () => {
    const result = await withFallback([], () => Promise.resolve("never"), new Map());

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected error");
    expect(result.error.code).toBe("VALIDATION");
  });

  test("records success in circuit breaker on success", async () => {
    const targets = [makeTarget("a")];
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 100,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });
    cb.recordFailure(500);
    cb.recordFailure(500);
    // Still CLOSED (threshold=3)

    const breakers = new Map([["a", cb]]);

    await withFallback(targets, () => Promise.resolve("ok"), breakers);

    // Success should have been recorded
    const snap = cb.getSnapshot();
    expect(snap.state).toBe("CLOSED");
  });

  test("records failure in circuit breaker on failure", async () => {
    const targets = [makeTarget("a")];
    const cb = createCircuitBreaker({
      failureThreshold: 3,
      cooldownMs: 60_000,
      failureWindowMs: 60_000,
      failureStatusCodes: [500],
    });
    const breakers = new Map([["a", cb]]);

    await withFallback(
      targets,
      () => {
        throw makeError("down");
      },
      breakers,
    );

    expect(cb.getSnapshot().failureCount).toBeGreaterThan(0);
  });

  test("tracks duration per attempt", async () => {
    let now = 0;
    const targets = [makeTarget("a"), makeTarget("b")];

    const result = await withFallback(
      targets,
      async (target) => {
        now += 100; // Simulate 100ms work
        if (target.id === "a") throw makeError("slow failure");
        return "ok";
      },
      new Map(),
      () => now,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected ok");
    expect(result.value.attempts[0]?.durationMs).toBe(100);
    expect(result.value.attempts[1]?.durationMs).toBe(100);
  });
});

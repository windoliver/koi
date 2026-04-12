import { describe, expect, test } from "bun:test";
import { createCircuitBreaker } from "./circuit-breaker.js";

describe("createCircuitBreaker", () => {
  test("same failing set N times trips circuit at N", () => {
    const cb = createCircuitBreaker(3);
    const failing = new Set(["crit_a", "crit_b"]);
    expect(cb.record(failing)).toBe(false); // count=1
    expect(cb.record(failing)).toBe(false); // count=2
    expect(cb.record(failing)).toBe(true); // count=3 — tripped
  });

  test("different failing set each time never trips", () => {
    const cb = createCircuitBreaker(2);
    expect(cb.record(new Set(["a"]))).toBe(false);
    expect(cb.record(new Set(["b"]))).toBe(false);
    expect(cb.record(new Set(["a"]))).toBe(false); // different from previous "b", resets
    expect(cb.record(new Set(["c"]))).toBe(false);
  });

  test("alternating A B A does not trip (counter resets on B)", () => {
    const cb = createCircuitBreaker(2);
    const setA = new Set(["a"]);
    const setB = new Set(["b"]);
    expect(cb.record(setA)).toBe(false); // count=1 for A
    expect(cb.record(setB)).toBe(false); // resets to count=1 for B
    expect(cb.record(setA)).toBe(false); // resets to count=1 for A — no trip
  });

  test("partial improvement resets counter", () => {
    const cb = createCircuitBreaker(2);
    // A and B both fail
    expect(cb.record(new Set(["a", "b"]))).toBe(false);
    // A and B again — count=2, should trip
    expect(cb.record(new Set(["a", "b"]))).toBe(true);
  });

  test("partial improvement before circuit trips resets counter", () => {
    const cb = createCircuitBreaker(3);
    expect(cb.record(new Set(["a", "b"]))).toBe(false); // count=1
    expect(cb.record(new Set(["a"]))).toBe(false); // different — resets, count=1
    expect(cb.record(new Set(["a"]))).toBe(false); // count=2
    expect(cb.record(new Set(["a"]))).toBe(true); // count=3 — tripped
  });

  test("empty failing set (all pass) resets counter and returns false", () => {
    const cb = createCircuitBreaker(2);
    const failing = new Set(["a"]);
    expect(cb.record(failing)).toBe(false);
    expect(cb.record(new Set<string>())).toBe(false); // all pass — reset
    expect(cb.consecutiveCount()).toBe(0);
  });

  test("reset() clears all state", () => {
    const cb = createCircuitBreaker(2);
    const failing = new Set(["a"]);
    cb.record(failing); // count=1
    cb.record(failing); // count=2, tripped
    cb.reset();
    expect(cb.consecutiveCount()).toBe(0);
    // After reset, same set starts fresh
    expect(cb.record(failing)).toBe(false); // count=1 — not tripped
  });

  test("consecutiveCount returns current count", () => {
    const cb = createCircuitBreaker(10);
    const failing = new Set(["x"]);
    cb.record(failing);
    cb.record(failing);
    expect(cb.consecutiveCount()).toBe(2);
  });

  test("maxConsecutive of 1 trips immediately on first identical consecutive failure", () => {
    const cb = createCircuitBreaker(1);
    const failing = new Set(["a"]);
    expect(cb.record(failing)).toBe(true); // first record already trips at count=1
  });
});

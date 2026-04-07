import { describe, expect, test } from "bun:test";
import { createMonotonicClock } from "./monotonic-clock.js";

describe("createMonotonicClock", () => {
  test("returns strictly increasing values when base clock is constant", () => {
    const clock = createMonotonicClock(() => 1000);
    const a = clock();
    const b = clock();
    const c = clock();
    expect(a).toBe(1000);
    expect(b).toBe(1001);
    expect(c).toBe(1002);
  });

  test("returns strictly increasing values when base clock goes backward", () => {
    // let: mutable — simulates clock jitter
    let value = 5000;
    const clock = createMonotonicClock(() => value);

    const a = clock();
    expect(a).toBe(5000);

    value = 4990; // clock goes backward by 10ms
    const b = clock();
    expect(b).toBe(5001); // must still increase

    value = 4995; // still behind last emitted
    const c = clock();
    expect(c).toBe(5002);
  });

  test("tracks real time when calls are spaced apart", () => {
    // let: mutable — simulates advancing wall clock
    let value = 1000;
    const clock = createMonotonicClock(() => value);

    expect(clock()).toBe(1000);

    value = 2000; // 1 second later
    expect(clock()).toBe(2000);

    value = 3000; // another second
    expect(clock()).toBe(3000);
  });

  test("defaults to Date.now when no base clock provided", () => {
    const clock = createMonotonicClock();
    const before = Date.now();
    const result = clock();
    const after = Date.now();
    expect(result).toBeGreaterThanOrEqual(before);
    expect(result).toBeLessThanOrEqual(after + 1);
  });

  test("first call returns baseClock() unmodified when starting at 0", () => {
    const clock = createMonotonicClock(() => 0);
    expect(clock()).toBe(0);
    expect(clock()).toBe(1); // subsequent calls increment
  });

  test("never returns the same value twice", () => {
    const clock = createMonotonicClock(() => 42);
    const seen = new Set<number>();
    for (let i = 0; i < 100; i++) {
      const v = clock();
      expect(seen.has(v)).toBe(false);
      seen.add(v);
    }
  });
});

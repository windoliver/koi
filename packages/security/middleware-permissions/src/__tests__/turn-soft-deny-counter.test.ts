import { describe, expect, test } from "bun:test";
import { createTurnSoftDenyCounter } from "../turn-soft-deny-counter.js";

describe("TurnSoftDenyCounter (#1650 — cumulative per turn, no reset on allow)", () => {
  test("countAndCap returns 'under_cap' for counts 1..cap, 'over_cap' after", () => {
    const c = createTurnSoftDenyCounter();
    expect(c.countAndCap("k", 3)).toBe("under_cap"); // 1
    expect(c.countAndCap("k", 3)).toBe("under_cap"); // 2
    expect(c.countAndCap("k", 3)).toBe("under_cap"); // 3
    expect(c.countAndCap("k", 3)).toBe("over_cap"); // 4
  });

  test("different keys are isolated", () => {
    const c = createTurnSoftDenyCounter();
    for (let i = 0; i < 10; i++) c.countAndCap("k1", 3);
    expect(c.countAndCap("k2", 3)).toBe("under_cap");
  });

  test("clear() zeros all counters (called on turn boundary)", () => {
    const c = createTurnSoftDenyCounter();
    c.countAndCap("k", 3);
    c.countAndCap("k", 3);
    c.clear();
    expect(c.countAndCap("k", 3)).toBe("under_cap"); // count restarts at 1
  });

  test("no reset-per-key API — allow decisions do not touch the counter", () => {
    const c = createTurnSoftDenyCounter();
    c.countAndCap("k", 3);
    c.countAndCap("k", 3);
    c.countAndCap("k", 3); // count=3
    // Only clear() exists; no reset-per-key.
    expect((c as unknown as { resetKey?: unknown }).resetKey).toBeUndefined();
    expect(c.countAndCap("k", 3)).toBe("over_cap");
  });
});

import { describe, expect, test } from "bun:test";
import { createRateLimitStore } from "./rate-limit.js";

describe("createRateLimitStore", () => {
  test("per-source bucket isolation", () => {
    const now = 0;
    const s = createRateLimitStore(() => now);
    const r1 = s.consumeSource("1.2.3.4", { capacity: 1, refillPerSec: 0.1 });
    expect(r1.allowed).toBe(true);
    const r2 = s.consumeSource("1.2.3.4", { capacity: 1, refillPerSec: 0.1 });
    expect(r2.allowed).toBe(false);
    const r3 = s.consumeSource("5.6.7.8", { capacity: 1, refillPerSec: 0.1 });
    expect(r3.allowed).toBe(true);
  });

  test("per-tenant bucket isolation", () => {
    const now = 0;
    const s = createRateLimitStore(() => now);
    const cfg = { capacity: 1, refillPerSec: 0.1 };
    expect(s.consumeTenant("ch", "t1", cfg).allowed).toBe(true);
    expect(s.consumeTenant("ch", "t1", cfg).allowed).toBe(false);
    expect(s.consumeTenant("ch", "t2", cfg).allowed).toBe(true);
  });

  test("retryAfter is reported when denied", () => {
    const now = 0;
    const s = createRateLimitStore(() => now);
    s.consumeSource("1.2.3.4", { capacity: 1, refillPerSec: 1 });
    const r = s.consumeSource("1.2.3.4", { capacity: 1, refillPerSec: 1 });
    expect(r.allowed).toBe(false);
    if (!r.allowed) expect(r.retryAfterMs).toBeGreaterThan(0);
  });
});

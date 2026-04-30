import { describe, expect, test } from "bun:test";
import { createTokenBucket } from "./token-bucket.js";

describe("createTokenBucket", () => {
  test("starts full", () => {
    const now = 0;
    const b = createTokenBucket({ capacity: 5, refillPerSec: 1 }, () => now);
    for (let i = 0; i < 5; i++) expect(b.tryConsume(1)).toBe(true);
    expect(b.tryConsume(1)).toBe(false);
  });

  test("refills over time", () => {
    let now = 0;
    const b = createTokenBucket({ capacity: 5, refillPerSec: 2 }, () => now);
    for (let i = 0; i < 5; i++) b.tryConsume(1);
    expect(b.tryConsume(1)).toBe(false);
    now += 500;
    expect(b.tryConsume(1)).toBe(true);
    expect(b.tryConsume(1)).toBe(false);
  });

  test("does not refill above capacity", () => {
    let now = 0;
    const b = createTokenBucket({ capacity: 3, refillPerSec: 100 }, () => now);
    now += 60_000;
    for (let i = 0; i < 3; i++) expect(b.tryConsume(1)).toBe(true);
    expect(b.tryConsume(1)).toBe(false);
  });

  test("retryAfterMs is positive when empty", () => {
    const now = 0;
    const b = createTokenBucket({ capacity: 1, refillPerSec: 2 }, () => now);
    b.tryConsume(1);
    expect(b.retryAfterMs(1)).toBeGreaterThan(0);
    expect(b.retryAfterMs(1)).toBeLessThanOrEqual(500);
  });
});

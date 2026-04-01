import { describe, expect, test } from "bun:test";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter", () => {
  test("allows messages under the limit", () => {
    const limiter = createRateLimiter({ maxMessages: 3, windowMs: 1000 });

    expect(limiter.check("client-1").allowed).toBe(true);
    expect(limiter.check("client-1").allowed).toBe(true);
    expect(limiter.check("client-1").allowed).toBe(true);
  });

  test("blocks messages over the limit", () => {
    const limiter = createRateLimiter({ maxMessages: 2, windowMs: 60_000 });

    expect(limiter.check("client-1").allowed).toBe(true);
    expect(limiter.check("client-1").allowed).toBe(true);

    const result = limiter.check("client-1");
    expect(result.allowed).toBe(false);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  test("tracks clients independently", () => {
    const limiter = createRateLimiter({ maxMessages: 1, windowMs: 60_000 });

    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.check("client-b").allowed).toBe(true);

    expect(limiter.check("client-a").allowed).toBe(false);
    expect(limiter.check("client-b").allowed).toBe(false);
  });

  test("allows messages after window expires", async () => {
    const limiter = createRateLimiter({ maxMessages: 1, windowMs: 50 });

    expect(limiter.check("client-1").allowed).toBe(true);
    expect(limiter.check("client-1").allowed).toBe(false);

    await Bun.sleep(60);

    expect(limiter.check("client-1").allowed).toBe(true);
  });

  test("reset clears a specific client", () => {
    const limiter = createRateLimiter({ maxMessages: 1, windowMs: 60_000 });

    expect(limiter.check("client-1").allowed).toBe(true);
    expect(limiter.check("client-1").allowed).toBe(false);

    limiter.reset("client-1");
    expect(limiter.check("client-1").allowed).toBe(true);
  });

  test("resetAll clears all clients", () => {
    const limiter = createRateLimiter({ maxMessages: 1, windowMs: 60_000 });

    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.check("client-b").allowed).toBe(true);

    limiter.resetAll();

    expect(limiter.check("client-a").allowed).toBe(true);
    expect(limiter.check("client-b").allowed).toBe(true);
  });
});

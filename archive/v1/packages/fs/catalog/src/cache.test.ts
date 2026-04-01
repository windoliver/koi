/**
 * Tests for the TTL cache utility.
 */

import { describe, expect, test } from "bun:test";
import { createTtlCache } from "./cache.js";

describe("createTtlCache", () => {
  test("returns cached value within TTL", async () => {
    let callCount = 0;
    const cache = createTtlCache(async () => {
      callCount += 1;
      return `result-${String(callCount)}`;
    }, 10_000);

    const first = await cache.get();
    const second = await cache.get();

    expect(first).toBe("result-1");
    expect(second).toBe("result-1");
    expect(callCount).toBe(1);
  });

  test("refetches after manual invalidation", async () => {
    let callCount = 0;
    const cache = createTtlCache(async () => {
      callCount += 1;
      return `result-${String(callCount)}`;
    }, Infinity);

    const first = await cache.get();
    expect(first).toBe("result-1");

    cache.invalidate();

    const second = await cache.get();
    expect(second).toBe("result-2");
    expect(callCount).toBe(2);
  });

  test("refetches after TTL expires", async () => {
    let callCount = 0;
    const cache = createTtlCache(async () => {
      callCount += 1;
      return `result-${String(callCount)}`;
    }, 1); // 1ms TTL

    const first = await cache.get();
    expect(first).toBe("result-1");

    // Wait for TTL to expire
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const second = await cache.get();
    expect(second).toBe("result-2");
    expect(callCount).toBe(2);
  });

  test("propagates fetch errors to caller", async () => {
    const cache = createTtlCache(async () => {
      throw new Error("fetch failed");
    }, 10_000);

    await expect(cache.get()).rejects.toThrow("fetch failed");
  });

  test("retries after a fetch error on next call", async () => {
    let callCount = 0;
    const cache = createTtlCache(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("transient failure");
      return "recovered";
    }, 10_000);

    // First call fails
    await expect(cache.get()).rejects.toThrow("transient failure");

    // Second call retries and succeeds
    const result = await cache.get();
    expect(result).toBe("recovered");
    expect(callCount).toBe(2);
  });

  test("deduplicates concurrent requests", async () => {
    let callCount = 0;
    const cache = createTtlCache(async () => {
      callCount += 1;
      // Simulate async delay
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      return `result-${String(callCount)}`;
    }, 10_000);

    // Fire multiple concurrent requests
    const [a, b, c] = await Promise.all([cache.get(), cache.get(), cache.get()]);

    expect(a).toBe("result-1");
    expect(b).toBe("result-1");
    expect(c).toBe("result-1");
    expect(callCount).toBe(1);
  });
});

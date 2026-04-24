import { describe, expect, test } from "bun:test";
import { createIdempotencyStore } from "./idempotency.js";

describe("createIdempotencyStore", () => {
  test("isDuplicate returns false for new key", () => {
    const store = createIdempotencyStore();
    expect(store.isDuplicate("key-1")).toBe(false);
  });

  test("isDuplicate returns true after record()", () => {
    const store = createIdempotencyStore();
    expect(store.isDuplicate("key-1")).toBe(false);
    store.record("key-1");
    expect(store.isDuplicate("key-1")).toBe(true);
  });

  test("isDuplicate without record() does not commit — transient failure allows retry", () => {
    const store = createIdempotencyStore();
    // First check: not a duplicate
    expect(store.isDuplicate("key-1")).toBe(false);
    // Simulate auth/dispatch failure: do NOT call record()
    // Retry: should still not be a duplicate
    expect(store.isDuplicate("key-1")).toBe(false);
    // Only commit after success
    store.record("key-1");
    expect(store.isDuplicate("key-1")).toBe(true);
  });

  test("different keys are independent", () => {
    const store = createIdempotencyStore();
    store.record("key-a");
    store.record("key-b");
    expect(store.isDuplicate("key-a")).toBe(true);
    expect(store.isDuplicate("key-b")).toBe(true);
    expect(store.isDuplicate("key-c")).toBe(false);
  });

  test("expired entry allows re-delivery", () => {
    const store = createIdempotencyStore({ ttlMs: 1 }); // 1ms TTL
    store.record("key-1");
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    expect(store.isDuplicate("key-1")).toBe(false);
  });

  test("maxSize evicts oldest entry on overflow", () => {
    // maxSize=2: record key-1, key-2 (full) → record key-3 evicts key-1 → {key-2, key-3}
    const store = createIdempotencyStore({ maxSize: 2 });
    store.record("key-1");
    store.record("key-2");
    store.record("key-3"); // evicts key-1
    // key-2 and key-3 are still present
    expect(store.isDuplicate("key-2")).toBe(true);
    expect(store.isDuplicate("key-3")).toBe(true);
    // key-1 was evicted — no longer a duplicate
    expect(store.isDuplicate("key-1")).toBe(false);
  });

  test("prune removes expired entries", () => {
    const store = createIdempotencyStore({ ttlMs: 1 });
    store.record("key-expire");
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    store.prune();
    expect(store.isDuplicate("key-expire")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { createIdempotencyStore } from "./idempotency.js";

describe("createIdempotencyStore", () => {
  test("first check returns true (new key)", () => {
    const store = createIdempotencyStore();
    expect(store.check("key-1")).toBe(true);
  });

  test("second check with same key returns false (duplicate)", () => {
    const store = createIdempotencyStore();
    store.check("key-1");
    expect(store.check("key-1")).toBe(false);
  });

  test("different keys are independent", () => {
    const store = createIdempotencyStore();
    expect(store.check("key-a")).toBe(true);
    expect(store.check("key-b")).toBe(true);
    expect(store.check("key-a")).toBe(false);
    expect(store.check("key-b")).toBe(false);
  });

  test("expired entry allows re-delivery", () => {
    const store = createIdempotencyStore({ ttlMs: 1 }); // 1ms TTL
    store.check("key-1");
    // Wait for expiry
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    // Should be treated as new after TTL
    expect(store.check("key-1")).toBe(true);
  });

  test("maxSize evicts oldest entry on overflow", () => {
    // maxSize=2: {key-1} → {key-1, key-2} (full) → key-3 evicts key-1 → {key-2, key-3}
    const store = createIdempotencyStore({ maxSize: 2 });
    store.check("key-1");
    store.check("key-2");
    // key-3 overflows: evicts key-1, store becomes {key-2, key-3}
    expect(store.check("key-3")).toBe(true); // new
    // key-2 and key-3 are still present
    expect(store.check("key-2")).toBe(false); // duplicate
    expect(store.check("key-3")).toBe(false); // duplicate
    // key-1 was evicted — re-accepted as new (evicts key-2 now)
    expect(store.check("key-1")).toBe(true);
  });

  test("prune removes expired entries", () => {
    const store = createIdempotencyStore({ ttlMs: 1 });
    store.check("key-expire");
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    store.prune();
    // After prune, same key is accepted again
    expect(store.check("key-expire")).toBe(true);
  });
});

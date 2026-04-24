import { describe, expect, test } from "bun:test";
import { createIdempotencyStore } from "./idempotency.js";

describe("createIdempotencyStore", () => {
  test("tryBegin returns true for new key", () => {
    const store = createIdempotencyStore();
    expect(store.tryBegin("key-1")).toBe(true);
  });

  test("tryBegin returns false for in-flight key (concurrent duplicate)", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1"); // reserve without committing
    expect(store.tryBegin("key-1")).toBe(false); // concurrent retry blocked
  });

  test("tryBegin returns false after commit (permanent duplicate)", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1");
    store.commit("key-1");
    expect(store.tryBegin("key-1")).toBe(false);
  });

  test("abort releases reservation — retry is accepted", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1");
    store.abort("key-1"); // transient failure — release
    expect(store.tryBegin("key-1")).toBe(true); // retry accepted
  });

  test("commit then abort does not re-open the key", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1");
    store.commit("key-1");
    store.abort("key-1"); // no-op (committed entry stays)
    // Should still be blocked
    expect(store.tryBegin("key-1")).toBe(false);
  });

  test("different keys are independent", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-a");
    store.commit("key-a");
    expect(store.tryBegin("key-b")).toBe(true);
    expect(store.tryBegin("key-a")).toBe(false);
  });

  test("expired committed entry allows re-delivery", () => {
    const store = createIdempotencyStore({ ttlMs: 1 });
    store.tryBegin("key-1");
    store.commit("key-1");
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    expect(store.tryBegin("key-1")).toBe(true);
  });

  test("maxSize evicts oldest committed entry on overflow", () => {
    // Eviction: one oldest committed entry is removed per commit call at capacity.
    // With maxSize=2: commit key-1, key-2. tryBegin key-3 (size becomes 3), commit
    // key-3 evicts key-1. Result: {key-2:committed, key-3:committed}.
    const store = createIdempotencyStore({ maxSize: 2 });
    store.tryBegin("key-1");
    store.commit("key-1");
    store.tryBegin("key-2");
    store.commit("key-2");
    // tryBegin("key-3") adds key-3:processing (size→3); commit("key-3") sees size > 2,
    // evicts key-1 (oldest committed), then commits key-3.
    // Result: {key-2:committed, key-3:committed}
    store.tryBegin("key-3");
    store.commit("key-3");
    // key-1 was evicted
    expect(store.tryBegin("key-1")).toBe(true);
    // key-2 and key-3 are still committed
    // (tryBegin("key-1") above adds key-1 as processing, doesn't evict key-2 or key-3 yet)
    expect(store.tryBegin("key-3")).toBe(false);
    expect(store.tryBegin("key-2")).toBe(false);
  });

  test("prune removes expired committed entries", () => {
    const store = createIdempotencyStore({ ttlMs: 1 });
    store.tryBegin("key-expire");
    store.commit("key-expire");
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    store.prune();
    expect(store.tryBegin("key-expire")).toBe(true);
  });
});

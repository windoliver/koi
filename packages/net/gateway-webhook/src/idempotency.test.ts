import { describe, expect, test } from "bun:test";
import { createIdempotencyStore } from "./idempotency.js";

describe("createIdempotencyStore", () => {
  test("tryBegin returns ok for new key", () => {
    const store = createIdempotencyStore();
    expect(store.tryBegin("key-1")).toBe("ok");
  });

  test("tryBegin returns in-flight for concurrent duplicate (processing key)", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1"); // reserve without committing
    expect(store.tryBegin("key-1")).toBe("in-flight"); // concurrent retry blocked
  });

  test("tryBegin returns duplicate after commit (permanent duplicate)", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1");
    store.commit("key-1");
    expect(store.tryBegin("key-1")).toBe("duplicate");
  });

  test("abort releases reservation — retry returns ok", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1");
    store.abort("key-1"); // transient failure — release
    expect(store.tryBegin("key-1")).toBe("ok"); // retry accepted
  });

  test("commit then abort does not re-open the key", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1");
    store.commit("key-1");
    store.abort("key-1"); // no-op (committed entry stays)
    expect(store.tryBegin("key-1")).toBe("duplicate");
  });

  test("different keys are independent", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-a");
    store.commit("key-a");
    expect(store.tryBegin("key-b")).toBe("ok");
    expect(store.tryBegin("key-a")).toBe("duplicate");
  });

  test("expired committed entry allows re-delivery", () => {
    const store = createIdempotencyStore({ ttlMs: 1 });
    store.tryBegin("key-1");
    store.commit("key-1");
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    expect(store.tryBegin("key-1")).toBe("ok");
  });

  test("maxSize evicts oldest committed entry to make room for new reservations", () => {
    // At capacity, tryBegin evicts the oldest committed entry (LRU-ish) so normal
    // sustained traffic does not degrade into capacity-exceeded errors.
    const store = createIdempotencyStore({ maxSize: 2 });
    store.tryBegin("key-1");
    store.commit("key-1");
    store.tryBegin("key-2");
    store.commit("key-2");
    // Store is full (2 committed). tryBegin evicts key-1 (oldest) to make room for key-3.
    // State: {key-2:committed, key-3:processing}
    expect(store.tryBegin("key-3")).toBe("ok");
    // key-3 is now in processing — tryBegin on key-3 again → in-flight
    expect(store.tryBegin("key-3")).toBe("in-flight");
    // key-1 was evicted — it can be re-delivered
    // (This evicts key-2 which is the only committed entry left.)
    expect(store.tryBegin("key-1")).toBe("ok");
    // key-2 was evicted by the key-1 reservation above — also available again
    store.abort("key-3"); // free a processing slot
    store.abort("key-1"); // free a processing slot
    expect(store.tryBegin("key-2")).toBe("ok"); // key-2 was evicted, so ok
  });

  test("tryBegin returns capacity-exceeded when store is full of in-flight entries", () => {
    // Only processing entries in the store — no committed to evict.
    const store = createIdempotencyStore({ maxSize: 2 });
    store.tryBegin("key-1"); // processing, not committed
    store.tryBegin("key-2"); // processing, not committed — store full
    expect(store.tryBegin("key-3")).toBe("capacity-exceeded");
    // Aborting one in-flight entry frees capacity
    store.abort("key-1");
    expect(store.tryBegin("key-3")).toBe("ok");
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
    expect(store.tryBegin("key-expire")).toBe("ok");
  });

  test("expired processing reservation is pruned — hung request cannot permanently burn a key", () => {
    // processingTtlMs=1 simulates a lease expiry for a hung/cancelled request.
    // After the TTL passes, tryBegin should accept the key as a fresh delivery.
    const store = createIdempotencyStore({ processingTtlMs: 1 });
    store.tryBegin("key-hung"); // reserve but never commit/abort (simulates a hang)
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    // The stale processing entry should be evicted by tryBegin's internal prune.
    expect(store.tryBegin("key-hung")).toBe("ok");
  });
});

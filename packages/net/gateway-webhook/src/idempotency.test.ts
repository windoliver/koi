import { describe, expect, test } from "bun:test";
import { createIdempotencyStore } from "./idempotency.js";

describe("createIdempotencyStore", () => {
  test("tryBegin returns ok with token for new key", () => {
    const store = createIdempotencyStore();
    const result = store.tryBegin("key-1");
    expect(result.state).toBe("ok");
    if (result.state === "ok") expect(typeof result.token).toBe("string");
  });

  test("tryBegin returns in-flight for concurrent duplicate (processing key)", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1"); // reserve without committing
    expect(store.tryBegin("key-1").state).toBe("in-flight"); // concurrent retry blocked
  });

  test("tryBegin returns duplicate after commit (permanent duplicate)", () => {
    const store = createIdempotencyStore();
    const r = store.tryBegin("key-1");
    if (r.state === "ok") store.commit("key-1", r.token);
    expect(store.tryBegin("key-1").state).toBe("duplicate");
  });

  test("abort releases reservation — retry returns ok", () => {
    const store = createIdempotencyStore();
    const r = store.tryBegin("key-1");
    if (r.state === "ok") store.abort("key-1", r.token); // transient failure — release
    expect(store.tryBegin("key-1").state).toBe("ok"); // retry accepted
  });

  test("commit then abort does not re-open the key", () => {
    const store = createIdempotencyStore();
    const r = store.tryBegin("key-1");
    if (r.state === "ok") {
      store.commit("key-1", r.token);
      store.abort("key-1", r.token); // no-op (committed entry stays)
    }
    expect(store.tryBegin("key-1").state).toBe("duplicate");
  });

  test("different keys are independent", () => {
    const store = createIdempotencyStore();
    const r = store.tryBegin("key-a");
    if (r.state === "ok") store.commit("key-a", r.token);
    expect(store.tryBegin("key-b").state).toBe("ok");
    expect(store.tryBegin("key-a").state).toBe("duplicate");
  });

  test("expired committed entry allows re-delivery", () => {
    const store = createIdempotencyStore({ ttlMs: 1 });
    const r = store.tryBegin("key-1");
    if (r.state === "ok") store.commit("key-1", r.token);
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    expect(store.tryBegin("key-1").state).toBe("ok");
  });

  test("stale commit after TTL expiry is a no-op — newer reservation wins", () => {
    // Simulates the processing TTL race: request A's TTL expires, B takes over,
    // then A's stale commit must not overwrite B's reservation.
    const store = createIdempotencyStore({ processingTtlMs: 1 });
    const rA = store.tryBegin("key-1"); // A reserves
    if (rA.state !== "ok") throw new Error("unexpected");
    // Wait for A's processing TTL to expire
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    // B now wins the key after prune removes A's expired entry
    const rB = store.tryBegin("key-1");
    expect(rB.state).toBe("ok"); // B won the reservation
    // A's stale commit with its old token must be a no-op
    store.commit("key-1", rA.token);
    // B's reservation is still in-flight (not committed by A)
    expect(store.tryBegin("key-1").state).toBe("in-flight");
    // B can still abort cleanly
    if (rB.state === "ok") store.abort("key-1", rB.token);
    expect(store.tryBegin("key-1").state).toBe("ok");
  });

  test("stale abort after TTL expiry is a no-op — does not release newer reservation", () => {
    const store = createIdempotencyStore({ processingTtlMs: 1 });
    const rA = store.tryBegin("key-1");
    if (rA.state !== "ok") throw new Error("unexpected");
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    const rB = store.tryBegin("key-1"); // B takes over after A's TTL expires
    expect(rB.state).toBe("ok");
    // A's stale abort with its old token must not release B's reservation
    store.abort("key-1", rA.token);
    expect(store.tryBegin("key-1").state).toBe("in-flight"); // B's reservation intact
  });

  test("maxSize evicts oldest committed entry to make room for new reservations", () => {
    // At capacity, tryBegin evicts the oldest committed entry (LRU-ish) so normal
    // sustained traffic does not degrade into capacity-exceeded errors.
    const store = createIdempotencyStore({ maxSize: 2 });
    // Fill with 2 committed entries
    const r1 = store.tryBegin("key-1");
    if (r1.state === "ok") store.commit("key-1", r1.token);
    const r2 = store.tryBegin("key-2");
    if (r2.state === "ok") store.commit("key-2", r2.token);
    // {key-1:committed, key-2:committed}

    // key-3 evicts key-1 (oldest committed) to make room
    const r3 = store.tryBegin("key-3");
    expect(r3.state).toBe("ok");
    // {key-2:committed, key-3:processing}

    // key-1 was evicted — it can be reserved again (evicts key-2 to make room)
    const r1b = store.tryBegin("key-1");
    expect(r1b.state).toBe("ok");
    // {key-3:processing, key-1:processing}

    // key-2 was evicted — now abort both processing slots to empty the store
    if (r3.state === "ok") store.abort("key-3", r3.token);
    if (r1b.state === "ok") store.abort("key-1", r1b.token);
    // {} — empty

    // key-2 was evicted earlier and is now available as a fresh delivery
    expect(store.tryBegin("key-2").state).toBe("ok");
  });

  test("tryBegin returns capacity-exceeded when store is full of in-flight entries", () => {
    // Only processing entries in the store — no committed to evict.
    const store = createIdempotencyStore({ maxSize: 2 });
    store.tryBegin("key-1"); // processing, not committed
    store.tryBegin("key-2"); // processing, not committed — store full
    expect(store.tryBegin("key-3").state).toBe("capacity-exceeded");
    // Aborting one in-flight entry frees capacity
    const r1 = store.tryBegin("key-1");
    // key-1 is still processing — abort requires token
    if (r1.state === "ok") store.abort("key-1", r1.token);
  });

  test("prune removes expired committed entries", () => {
    const store = createIdempotencyStore({ ttlMs: 1 });
    const r = store.tryBegin("key-expire");
    if (r.state === "ok") store.commit("key-expire", r.token);
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    store.prune();
    expect(store.tryBegin("key-expire").state).toBe("ok");
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
    expect(store.tryBegin("key-hung").state).toBe("ok");
  });
});

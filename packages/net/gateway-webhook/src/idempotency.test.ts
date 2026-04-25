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

  test("renew extends processing TTL — active dispatch keeps its reservation", () => {
    // processingTtlMs=20ms: without renewal the entry would expire after 20ms.
    // renew() is called before the 20ms window closes, resetting the clock.
    const store = createIdempotencyStore({ processingTtlMs: 20 });
    const r = store.tryBegin("key-1");
    if (r.state !== "ok") throw new Error("unexpected");
    // Wait 15ms — close to expiry but not yet expired
    const halfway = Date.now() + 15;
    while (Date.now() < halfway) {
      /* spin */
    }
    // Renew resets the TTL to 20ms from now
    const renewed = store.renew("key-1", r.token);
    expect(renewed).toBe(true);
    // Wait another 15ms — without renewal this would have expired, but with it, it's still valid
    const later = Date.now() + 15;
    while (Date.now() < later) {
      /* spin */
    }
    // Entry is still in-flight (renewed TTL hasn't elapsed yet)
    expect(store.tryBegin("key-1").state).toBe("in-flight");
  });

  test("renew with wrong token is a no-op", () => {
    const store = createIdempotencyStore();
    store.tryBegin("key-1");
    expect(store.renew("key-1", "wrong-token")).toBe(false);
  });

  test("renew on committed entry is a no-op — returns false", () => {
    const store = createIdempotencyStore();
    const r = store.tryBegin("key-1");
    if (r.state === "ok") store.commit("key-1", r.token);
    const renewed = r.state === "ok" ? store.renew("key-1", r.token) : false;
    expect(renewed).toBe(false);
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

  test("maxSize returns capacity-exceeded for both committed and in-flight stores", () => {
    // Committed entries are NOT evicted to make room — silence eviction risks
    // duplicate side effects when a provider retries an evicted delivery.
    const store = createIdempotencyStore({ maxSize: 2 });
    const r1 = store.tryBegin("key-1");
    if (r1.state === "ok") store.commit("key-1", r1.token);
    const r2 = store.tryBegin("key-2");
    if (r2.state === "ok") store.commit("key-2", r2.token);
    // Store is full with 2 committed entries — new reservation is rejected
    expect(store.tryBegin("key-3").state).toBe("capacity-exceeded");
    // Existing committed keys are still blocked
    expect(store.tryBegin("key-1").state).toBe("duplicate");
    expect(store.tryBegin("key-2").state).toBe("duplicate");
  });

  test("tryBegin returns capacity-exceeded when store is full of in-flight entries", () => {
    // Only processing entries in the store — capacity-exceeded returned
    const store = createIdempotencyStore({ maxSize: 2 });
    store.tryBegin("key-1"); // processing
    store.tryBegin("key-2"); // processing — store full
    expect(store.tryBegin("key-3").state).toBe("capacity-exceeded");
  });

  test("capacity frees up after abort and TTL expiry", () => {
    const store = createIdempotencyStore({ maxSize: 1 });
    const r = store.tryBegin("key-1");
    expect(r.state).toBe("ok");
    if (r.state === "ok") store.abort("key-1", r.token);
    // Slot freed — next key can be reserved
    expect(store.tryBegin("key-2").state).toBe("ok");
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
    // processingTtlMs=1 simulates a lease expiry for a dead request (one that
    // stopped renewing). After the TTL passes, tryBegin should accept the key.
    const store = createIdempotencyStore({ processingTtlMs: 1 });
    store.tryBegin("key-hung"); // reserve but never renew/commit/abort
    const deadline = Date.now() + 50;
    while (Date.now() < deadline) {
      /* spin */
    }
    // The stale processing entry should be evicted by tryBegin's internal prune.
    expect(store.tryBegin("key-hung").state).toBe("ok");
  });
});

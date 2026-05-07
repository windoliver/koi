import { describe, expect, test } from "bun:test";
import { type IdempotencyStore, InMemoryIdempotencyStore } from "./idempotency-store.js";

describe("InMemoryIdempotencyStore", () => {
  const ttl = 1000;

  test("tryBegin returns ok for unseen key", async () => {
    const s: IdempotencyStore = new InMemoryIdempotencyStore();
    const r = await s.tryBegin("k1", 100);
    expect(r.ok).toBe(true);
  });

  test("concurrent tryBegin: exactly one ok", async () => {
    const s = new InMemoryIdempotencyStore();
    const [a, b] = await Promise.all([s.tryBegin("k1", 100), s.tryBegin("k1", 100)]);
    const oks = [a, b].filter((r) => r.ok).length;
    expect(oks).toBe(1);
  });

  test("commit then tryBegin returns committed", async () => {
    const s = new InMemoryIdempotencyStore();
    const r = await s.tryBegin("k1", 100);
    if (!r.ok) throw new Error("first should win");
    await s.commit(r.lease, ttl);
    const r2 = await s.tryBegin("k1", 100);
    expect(r2).toEqual({ ok: false, reason: "committed" });
  });

  test("abort releases lease for re-claim", async () => {
    const s = new InMemoryIdempotencyStore();
    const r = await s.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await s.abort(r.lease);
    const r2 = await s.tryBegin("k1", 100);
    expect(r2.ok).toBe(true);
  });

  test("renew extends lease", async () => {
    const s = new InMemoryIdempotencyStore({ now: () => 0 });
    const r = await s.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await s.renew(r.lease, 200);
    const r2 = await s.tryBegin("k1", 100);
    expect(r2).toEqual({ ok: false, reason: "in-flight" });
  });

  test("capacity exhausted returns reason", async () => {
    const s = new InMemoryIdempotencyStore({ maxCommittedRecords: 1 });
    const r1 = await s.tryBegin("k1", 100);
    if (!r1.ok) throw new Error();
    await s.commit(r1.lease, 1000);
    const r2 = await s.tryBegin("k2", 100);
    expect(r2).toEqual({ ok: false, reason: "capacity-exhausted" });
  });

  test("commit ttl expiry releases for re-delivery", async () => {
    let now = 0;
    const s = new InMemoryIdempotencyStore({ now: () => now });
    const r = await s.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await s.commit(r.lease, 50);
    now = 51;
    const r2 = await s.tryBegin("k1", 100);
    expect(r2.ok).toBe(true);
  });

  test("commit with stale token rejects after lease was reissued", async () => {
    const s = new InMemoryIdempotencyStore();
    const r1 = await s.tryBegin("k1", 100);
    if (!r1.ok) throw new Error();
    await s.abort(r1.lease);
    const r2 = await s.tryBegin("k1", 100);
    if (!r2.ok) throw new Error();
    expect(s.commit(r1.lease, 1000)).rejects.toThrow();
    // Second lease still valid:
    await s.commit(r2.lease, 1000);
  });

  test("abort with stale token does not wipe a reissued lease", async () => {
    const s = new InMemoryIdempotencyStore();
    const r1 = await s.tryBegin("k1", 100);
    if (!r1.ok) throw new Error();
    await s.abort(r1.lease);
    const r2 = await s.tryBegin("k1", 100);
    if (!r2.ok) throw new Error();
    // Stale aborter should be a silent no-op, not delete the active lease.
    await s.abort(r1.lease);
    const r3 = await s.tryBegin("k1", 100);
    expect(r3).toEqual({ ok: false, reason: "in-flight" });
    await s.commit(r2.lease, 1000);
  });

  test("global TTL prune: expired committed records do not block fresh keys at capacity", async () => {
    // Regression: previously expired committed records were only
    // deleted when their exact key was retried. After enough churn,
    // unrelated stale entries counted toward maxCommittedRecords and
    // fresh keys returned `capacity-exhausted` permanently. The store
    // now prunes globally when capacity is at risk.
    let now = 0;
    const s = new InMemoryIdempotencyStore({ maxCommittedRecords: 2, now: () => now });
    const r1 = await s.tryBegin("a", 100);
    if (!r1.ok) throw new Error();
    await s.commit(r1.lease, 50);
    const r2 = await s.tryBegin("b", 100);
    if (!r2.ok) throw new Error();
    await s.commit(r2.lease, 50);
    // Both expire.
    now = 100;
    // A fresh key would have been rejected as capacity-exhausted
    // before the prune fix, despite both stored entries being stale.
    const r3 = await s.tryBegin("c", 100);
    expect(r3.ok).toBe(true);
  });
});

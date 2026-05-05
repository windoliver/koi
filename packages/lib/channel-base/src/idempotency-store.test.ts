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
});

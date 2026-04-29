import { describe, expect, test } from "bun:test";
import { createIdempotencyStore } from "./idempotency.js";

const cfg = { perTenantCapacity: 5, maxTenants: 100, ttlSeconds: 60 };

describe("createIdempotencyStore", () => {
  test("reserve -> first wins, second is in-flight", () => {
    const now = 0;
    const s = createIdempotencyStore(cfg, () => now);
    const a = s.reserve("ch", "t", "d1");
    expect(a.kind).toBe("reserved");
    const b = s.reserve("ch", "t", "d1");
    expect(b.kind).toBe("in-flight");
  });

  test("complete -> subsequent reserve returns cached", () => {
    const now = 0;
    const s = createIdempotencyStore(cfg, () => now);
    s.reserve("ch", "t", "d1");
    s.complete("ch", "t", "d1", { status: 200, body: "ok", frameId: "f1" });
    const r = s.reserve("ch", "t", "d1");
    expect(r.kind).toBe("cached");
    if (r.kind === "cached") {
      expect(r.response.status).toBe(200);
      expect(r.response.frameId).toBe("f1");
    }
  });

  test("clear (5xx path) -- next reserve re-attempts", () => {
    const now = 0;
    const s = createIdempotencyStore(cfg, () => now);
    s.reserve("ch", "t", "d1");
    s.clear("ch", "t", "d1");
    expect(s.reserve("ch", "t", "d1").kind).toBe("reserved");
  });

  test("ttl expiry", () => {
    let now = 0;
    const s = createIdempotencyStore(cfg, () => now);
    s.reserve("ch", "t", "d1");
    s.complete("ch", "t", "d1", { status: 200, body: "ok", frameId: "f" });
    now += 61 * 1000;
    expect(s.reserve("ch", "t", "d1").kind).toBe("reserved");
  });

  test("per-tenant isolation -- noisy tenant cannot evict another's completed entry", () => {
    const now = 0;
    const s = createIdempotencyStore({ ...cfg, perTenantCapacity: 3 }, () => now);
    s.reserve("ch", "victim", "v");
    s.complete("ch", "victim", "v", { status: 200, body: "ok", frameId: "f" });
    for (let i = 0; i < 50; i++) {
      s.reserve("ch", "noisy", `d${i}`);
      s.complete("ch", "noisy", `d${i}`, { status: 200, body: "ok", frameId: `f${i}` });
    }
    const r = s.reserve("ch", "victim", "v");
    expect(r.kind).toBe("cached");
  });
});

import { describe, expect, test } from "bun:test";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";
import { InMemoryIngressQueue } from "./ingress-queue.js";
import { assertDurableInProduction } from "./production-guards.js";

describe("assertDurableInProduction", () => {
  test("non-production: always ok", () => {
    const r = assertDurableInProduction(false, [
      { name: "x", store: new InMemoryIdempotencyStore() },
    ]);
    expect(r.ok).toBe(true);
  });

  test("production: in-memory store is ephemeral and rejected", () => {
    const r = assertDurableInProduction(true, [
      { name: "idempotencyStore", store: new InMemoryIdempotencyStore() },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("idempotencyStore");
  });

  test("production: explicit durability declaration is the contract — instanceof wrappers are NOT trusted", () => {
    // Regression: the previous instanceof-based check trusted any
    // wrapper that forwarded to InMemory*Store. A durability claim
    // is now an explicit property: stores that omit it are rejected
    // even if they wrap (via composition) a non-durable backing.
    const wrapper = {
      // No `durability` property — must be rejected.
      tryBegin: () => null,
      commit: () => null,
      commitPoison: () => null,
      abort: () => null,
      renew: () => null,
    };
    const r = assertDurableInProduction(true, [{ name: "wrapped", store: wrapper }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("wrapped");
  });

  test("production: durable-declared store passes", () => {
    const durable = { durability: "durable" as const };
    const r = assertDurableInProduction(true, [
      { name: "ok", store: durable },
      { name: "queue", store: new InMemoryIngressQueue() },
    ]);
    expect(r.ok).toBe(false); // because the queue is ephemeral
    if (r.ok) return;
    expect(r.error.message).toContain("queue");
    expect(r.error.message).not.toContain("ok");
  });
});

import { describe, expect, test } from "bun:test";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";
import { InMemoryIngressQueue } from "./ingress-queue.js";
import { assertDurableInProduction, isDurable, markDurable } from "./production-guards.js";

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

  test('production: a self-declared `durability: "durable"` plain object is NOT trusted', () => {
    // Regression: previously the guard trusted any object with a
    // `durability: "durable"` string property — a thin wrapper around
    // an in-memory store could opt into production by typing one
    // string. The brand symbol set by `markDurable()` is the only
    // accepted attestation; a plain literal cannot reproduce it.
    const spoof = {
      durability: "durable" as const,
      tryBegin: () => null,
      commit: () => null,
    };
    const r = assertDurableInProduction(true, [{ name: "spoof", store: spoof }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("spoof");
  });

  test("production: a markDurable()-branded store passes", () => {
    const durable = markDurable({
      tryBegin: () => null,
      commit: () => null,
    });
    expect(isDurable(durable)).toBe(true);
    const r = assertDurableInProduction(true, [
      { name: "ok", store: durable },
      { name: "queue", store: new InMemoryIngressQueue() },
    ]);
    // The queue is still ephemeral, so the call as a whole fails — but
    // only the queue is named in the offender list.
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("queue");
    expect(r.error.message).not.toContain("ok");
  });

  test("production: stores that omit declaration entirely are rejected", () => {
    const wrapper = {
      tryBegin: () => null,
      commit: () => null,
    };
    const r = assertDurableInProduction(true, [{ name: "wrapped", store: wrapper }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.message).toContain("wrapped");
  });

  test("isDurable returns false for plain objects, true for branded", () => {
    expect(isDurable({})).toBe(false);
    expect(isDurable({ durability: "durable" })).toBe(false);
    expect(isDurable(markDurable({}))).toBe(true);
  });
});

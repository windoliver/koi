import { describe, expect, test } from "bun:test";
import { startHandlerWorker } from "./handler-worker.js";
import { InMemoryIdempotencyStore } from "./idempotency-store.js";
import { InMemoryIngressQueue } from "./ingress-queue.js";

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("startHandlerWorker", () => {
  test("invokes handler exactly once on success", async () => {
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    const calls: number[] = [];
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: idem,
      handler: async (item) => {
        calls.push(item.payload.v);
      },
      commitTtlMs: 1000,
      handlerTimeoutMs: 1000,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 42 }, normalized: null });
    await tick();
    await stop();
    expect(calls).toEqual([42]);
  });

  test("retries on handler throw up to maxRetries then dead-letters", async () => {
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    let attempts = 0;
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: idem,
      handler: async () => {
        attempts++;
        throw new Error("boom");
      },
      commitTtlMs: 1000,
      handlerTimeoutMs: 1000,
      maxHandlerRetries: 2,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    await tick(80);
    await stop();
    expect(attempts).toBeGreaterThanOrEqual(2);
    const dl = await queue.getDeadLetters();
    expect(dl).toHaveLength(1);
  });

  test("auto-renews lease while handler runs", async () => {
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    let renewals = 0;
    const wrapped = {
      tryBegin: idem.tryBegin.bind(idem),
      commit: idem.commit.bind(idem),
      abort: idem.abort.bind(idem),
      renew: async (
        lease: { readonly key: string; readonly token: string; readonly expiresAt: number },
        ms: number,
      ) => {
        renewals++;
        return idem.renew(lease, ms);
      },
    };
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: wrapped,
      handler: async () => new Promise((r) => setTimeout(r, 60)),
      commitTtlMs: 1000,
      handlerTimeoutMs: 1000,
      leaseMs: 30,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    await tick(80);
    await stop();
    expect(renewals).toBeGreaterThan(0);
  });

  test("handler timeout aborts lease and nacks", async () => {
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    let started = 0;
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: idem,
      handler: async () => {
        started++;
        return new Promise<void>(() => {}); // never resolves
      },
      commitTtlMs: 1000,
      handlerTimeoutMs: 20,
      maxHandlerRetries: 1,
      leaseMs: 100,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    await tick(80);
    await stop();
    expect(started).toBeGreaterThanOrEqual(1);
    const dl = await queue.getDeadLetters();
    expect(dl).toHaveLength(1);
  });

  test("already-committed key is acked without invoking handler", async () => {
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    let calls = 0;
    // pre-commit the key
    const r = await idem.tryBegin("k1", 100);
    if (!r.ok) throw new Error();
    await idem.commit(r.lease, 10_000);
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: idem,
      handler: async () => {
        calls++;
      },
      commitTtlMs: 1000,
      handlerTimeoutMs: 1000,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    await tick(20);
    await stop();
    expect(calls).toBe(0);
    expect(await queue.claim("w2", 100)).toBeNull();
  });
});

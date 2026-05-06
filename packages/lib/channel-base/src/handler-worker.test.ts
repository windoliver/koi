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

  test("lease equals handlerTimeoutMs (no mid-handler renewal)", async () => {
    // Renewal-free model: see handler-worker.ts file header.
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    let renewals = 0;
    const wrapped = {
      tryBegin: idem.tryBegin.bind(idem),
      commit: idem.commit.bind(idem),
      commitPoison: idem.commitPoison.bind(idem),
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
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    await tick(120);
    await stop();
    // renewals MUST be zero — the new architecture takes the lease for
    // the full handlerTimeoutMs and never renews mid-flight.
    expect(renewals).toBe(0);
  });

  test("handler timeout: lease retained until expiry, no successor reclaim, no dead-letter", async () => {
    // The public MessageHandler contract is single-arg (no AbortSignal),
    // so the worker cannot guarantee a hung handler stopped. Releasing
    // the queue claim or idempotency lease on timeout would let a
    // successor reclaim and re-execute concurrently with the original.
    // The worker therefore moves on without releasing — the lease
    // expires naturally after handlerTimeoutMs + leaseGraceMs and the
    // queue/store machinery handles post-expiry reclaim. Within the
    // lease window, no second invocation occurs.
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
      leaseGraceMs: 5_000,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    await tick(80);
    await stop();
    // Within the 80ms test window, only the original invocation ran:
    // the lease window (20+5000=5020ms) protects against successor
    // reclaim. Releasing on timeout would have allowed multiple
    // concurrent invocations.
    expect(started).toBe(1);
    const dl = await queue.getDeadLetters();
    expect(dl).toHaveLength(0);
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

  test("commitPoison failure on max-retry blocks dead-letter (item stays retryable)", async () => {
    // Regression: if the poison tombstone cannot land durably on a
    // max-retry terminal path, dead-lettering would remove the queue
    // item without a terminal marker — a future redelivery would
    // then run the handler again with no dedupe protection. Worker
    // MUST nack instead so operators see retries rather than silent
    // duplication.
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    const wrapped = {
      tryBegin: idem.tryBegin.bind(idem),
      commit: idem.commit.bind(idem),
      commitPoison: async () => {
        throw new Error("store unavailable");
      },
      abort: idem.abort.bind(idem),
      renew: idem.renew.bind(idem),
    };
    let calls = 0;
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: wrapped,
      handler: async () => {
        calls++;
        // Yield once so the loop doesn't starve macrotasks.
        await new Promise((r) => setTimeout(r, 5));
        throw new Error("explicit handler failure");
      },
      commitTtlMs: 1000,
      handlerTimeoutMs: 1000,
      maxHandlerRetries: 1,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("ky", { key: "ky", payload: { v: 1 }, normalized: null });
    await tick(60);
    await stop();
    // Handler ran multiple times: each terminal attempt called
    // commitPoison, failed, aborted lease + nacked → re-claim →
    // handler ran again. If commitPoison failure had not blocked
    // dead-letter, calls would be 1 (single terminal attempt).
    expect(calls).toBeGreaterThan(1);
    const dl = await queue.getDeadLetters();
    expect(dl).toHaveLength(0);
  });

  test("poisoned key replay is dead-lettered, not acked", async () => {
    // Drain-gated adapters (email IMAP) treat ack as handler success.
    // A redelivered queue item whose key has a POISON tombstone must
    // surface as a dead-letter on awaitDrain so the adapter keeps the
    // source message un-acked for operator triage.
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    let calls = 0;
    const r = await idem.tryBegin("k-poison", 100);
    if (!r.ok) throw new Error();
    await idem.commitPoison(r.lease, 10_000);
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
    await queue.enqueue("k-poison", { key: "k-poison", payload: { v: 1 }, normalized: null });
    const drain = await queue.awaitDrain("k-poison");
    await stop();
    expect(calls).toBe(0);
    expect(drain.ok).toBe(false);
  });
});

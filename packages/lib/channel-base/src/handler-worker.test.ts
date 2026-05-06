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

  test("handler timeout: poison tombstone + dead-letter, drain unblocks, no successor reclaim", async () => {
    // Timeout requires a terminal observable outcome (so drain-gated
    // adapters' awaitDrain unblocks) AND single-execution
    // preservation (the original handler may still run; we cannot
    // stop it without an enforceable AbortSignal). Poison + dead-
    // letter is the only combination that meets both: the original
    // runs to completion in the background, future redelivery is
    // suppressed by the poison tombstone, and awaitDrain fires
    // ok:false so source-side callbacks can keep the message un-
    // acked for operator triage.
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
    const drain = await queue.awaitDrain("k1");
    await stop();
    // Original ran exactly once (no successor reclaim).
    expect(started).toBe(1);
    expect(drain.ok).toBe(false);
    const dl = await queue.getDeadLetters();
    expect(dl).toHaveLength(1);
    // Future redelivery: poison tombstone suppresses re-execution.
    const r = await idem.tryBegin("k1", 1000);
    expect(r).toEqual({ ok: false, reason: "poisoned" });
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

  test("handler timeout + poison-commit failure: still dead-letters (drain unblocks)", async () => {
    // Regression: previously the timeout branch left the queue item
    // in limbo when commitPoisonDurably failed (no ack, no
    // deadLetter), which blocked awaitDrain forever and wedged
    // drain-gated channels (email IMAP). Now the timeout path
    // deadLetters unconditionally so the source-side callback always
    // sees a terminal outcome. The lease is intentionally NOT
    // aborted — the active (or naturally-expiring) lease prevents
    // successor reclaim during the original handler's run.
    const queue = new InMemoryIngressQueue<{ readonly v: number }, null>();
    const idem = new InMemoryIdempotencyStore();
    const wrapped = {
      tryBegin: idem.tryBegin.bind(idem),
      commit: idem.commit.bind(idem),
      commitPoison: async () => {
        throw new Error("idempotency store unavailable during outage");
      },
      abort: idem.abort.bind(idem),
      renew: idem.renew.bind(idem),
    };
    let started = 0;
    const stop = startHandlerWorker({
      queue,
      idempotencyStore: wrapped,
      handler: async () => {
        started++;
        return new Promise<void>(() => {});
      },
      commitTtlMs: 1000,
      handlerTimeoutMs: 20,
      leaseGraceMs: 5_000,
      pollIntervalMs: 1,
      workerId: "w1",
    });
    await queue.enqueue("k1", { key: "k1", payload: { v: 1 }, normalized: null });
    const drain = await queue.awaitDrain("k1");
    await stop();
    expect(started).toBe(1);
    expect(drain.ok).toBe(false);
    const dl = await queue.getDeadLetters();
    expect(dl).toHaveLength(1);
    expect(dl[0]?.reason).toContain("poison-commit-failed");
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

import { describe, expect, test } from "bun:test";
import { createConcurrencySemaphore } from "./concurrency-semaphore.js";

describe("createConcurrencySemaphore", () => {
  // -------------------------------------------------------------------------
  // Basic behavior
  // -------------------------------------------------------------------------

  test("resolves immediately when slots available", async () => {
    const sem = createConcurrencySemaphore(2);
    await sem.acquire(1_000);
    expect(sem.activeCount()).toBe(1);
    await sem.acquire(1_000);
    expect(sem.activeCount()).toBe(2);
  });

  test("queues when all slots taken", async () => {
    const sem = createConcurrencySemaphore(1);
    await sem.acquire(1_000);

    // let justified: mutable flag set by deferred acquire
    let acquired = false;
    const pending = sem.acquire(5_000).then(() => {
      acquired = true;
    });

    // Yield to microtask queue — still blocked
    await Promise.resolve();
    expect(acquired).toBe(false);
    expect(sem.waitingCount()).toBe(1);

    // Release the held slot — pending waiter should fire
    sem.release();
    await pending;
    expect(acquired).toBe(true);
    expect(sem.activeCount()).toBe(1);
    expect(sem.waitingCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // FIFO ordering
  // -------------------------------------------------------------------------

  test("serves waiters in FIFO order", async () => {
    const sem = createConcurrencySemaphore(1);
    await sem.acquire(1_000);

    const order: number[] = [];
    const p1 = sem.acquire(5_000).then(() => {
      order.push(1);
    });
    const p2 = sem.acquire(5_000).then(() => {
      order.push(2);
    });

    expect(sem.waitingCount()).toBe(2);

    // Release twice — first release serves waiter 1, second serves waiter 2
    sem.release();
    await p1;
    sem.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });

  // -------------------------------------------------------------------------
  // Timeout
  // -------------------------------------------------------------------------

  test("rejects with Error on timeout", async () => {
    const sem = createConcurrencySemaphore(1);
    await sem.acquire(1_000);

    try {
      await sem.acquire(10); // very short timeout
      expect.unreachable("should have timed out");
    } catch (e: unknown) {
      expect(e).toBeInstanceOf(Error);
      if (e instanceof Error) {
        expect(e.message).toContain("timed out");
      }
    }

    // Slot still held — only original acquire
    expect(sem.activeCount()).toBe(1);
  });

  test("timed-out waiter does not consume a slot on release", async () => {
    const sem = createConcurrencySemaphore(1);
    await sem.acquire(1_000);

    // Queue a waiter that will time out
    const timedOut = sem.acquire(10).catch(() => "timed_out");
    await timedOut; // wait for timeout to fire

    // Queue a fresh waiter
    // let justified: mutable flag to track fresh acquire
    let freshAcquired = false;
    const fresh = sem.acquire(5_000).then(() => {
      freshAcquired = true;
    });

    // Release original — should skip timed-out waiter and serve fresh one
    sem.release();
    await fresh;
    expect(freshAcquired).toBe(true);
    expect(sem.activeCount()).toBe(1);
    expect(sem.waitingCount()).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Count tracking
  // -------------------------------------------------------------------------

  test("activeCount and waitingCount track correctly", async () => {
    const sem = createConcurrencySemaphore(2);
    expect(sem.activeCount()).toBe(0);
    expect(sem.waitingCount()).toBe(0);

    await sem.acquire(1_000);
    expect(sem.activeCount()).toBe(1);

    await sem.acquire(1_000);
    expect(sem.activeCount()).toBe(2);

    const pending = sem.acquire(5_000);
    expect(sem.waitingCount()).toBe(1);
    expect(sem.activeCount()).toBe(2);

    sem.release(); // hands slot to pending waiter
    await pending;
    expect(sem.activeCount()).toBe(2);
    expect(sem.waitingCount()).toBe(0);

    sem.release();
    expect(sem.activeCount()).toBe(1);
    sem.release();
    expect(sem.activeCount()).toBe(0);
  });
});

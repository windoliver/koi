import { describe, expect, test } from "bun:test";
import { createSemaphore } from "./semaphore.js";

describe("createSemaphore", () => {
  test("immediate acquire when under capacity", async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    expect(sem.activeCount()).toBe(1);
    await sem.acquire();
    expect(sem.activeCount()).toBe(2);
  });

  test("blocks when at capacity, unblocks on release", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();
    expect(sem.activeCount()).toBe(1);

    // This acquire will block
    let acquired = false;
    const pending = sem.acquire().then(() => {
      acquired = true;
    });

    // Give microtask a chance to run — should still be blocked
    await Promise.resolve();
    expect(acquired).toBe(false);

    // Release unblocks the waiter
    sem.release();
    await pending;
    expect(acquired).toBe(true);
    expect(sem.activeCount()).toBe(1);
  });

  test("FIFO ordering of waiters", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();

    const order: number[] = [];
    const p1 = sem.acquire().then(() => order.push(1));
    const p2 = sem.acquire().then(() => order.push(2));

    sem.release();
    await p1;
    sem.release();
    await p2;

    expect(order).toEqual([1, 2]);
  });

  test("release decrements active count", () => {
    const sem = createSemaphore(3);
    // Synchronously acquire 2
    void sem.acquire();
    void sem.acquire();
    expect(sem.activeCount()).toBe(2);
    sem.release();
    expect(sem.activeCount()).toBe(1);
  });
});

import { describe, expect, it } from "bun:test";
import { createSemaphore } from "./semaphore.js";

describe("createSemaphore", () => {
  it("resolves immediately when under capacity", async () => {
    const sem = createSemaphore(3);
    expect(sem.activeCount()).toBe(0);

    await sem.acquire();
    expect(sem.activeCount()).toBe(1);

    await sem.acquire();
    expect(sem.activeCount()).toBe(2);

    sem.release();
    expect(sem.activeCount()).toBe(1);
  });

  it("blocks when at capacity and resumes on release", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();
    expect(sem.activeCount()).toBe(1);

    // let justified: mutable flag tracking whether acquire resolved
    let acquired = false;
    const pending = sem.acquire().then(() => {
      acquired = true;
    });

    // Give microtask queue a chance to run
    await Promise.resolve();
    expect(acquired).toBe(false);

    sem.release();
    await pending;
    expect(acquired).toBe(true);
  });

  it("respects maxConcurrency limit", async () => {
    const sem = createSemaphore(2);
    await sem.acquire();
    await sem.acquire();

    // let justified: mutable flag tracking third acquire
    let thirdAcquired = false;
    const pending = sem.acquire().then(() => {
      thirdAcquired = true;
    });

    await Promise.resolve();
    expect(thirdAcquired).toBe(false);

    sem.release();
    await pending;
    expect(thirdAcquired).toBe(true);
  });

  it("maintains FIFO ordering", async () => {
    const sem = createSemaphore(1);
    await sem.acquire();

    const order: number[] = [];

    const p1 = sem.acquire().then(() => {
      order.push(1);
    });
    const p2 = sem.acquire().then(() => {
      order.push(2);
    });
    const p3 = sem.acquire().then(() => {
      order.push(3);
    });

    sem.release();
    await p1;

    sem.release();
    await p2;

    sem.release();
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it("handles release without pending waiters", () => {
    const sem = createSemaphore(3);
    // Acquire and release without anyone waiting
    const _p = sem.acquire();
    // acquire resolves synchronously when under capacity
    expect(sem.activeCount()).toBe(1);
    sem.release();
    expect(sem.activeCount()).toBe(0);
  });

  it("works with concurrent acquire/release cycles", async () => {
    const sem = createSemaphore(2);
    const results: number[] = [];

    const tasks = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        await sem.acquire();
        results.push(i);
        // Simulate some async work
        await Promise.resolve();
        sem.release();
      })(),
    );

    await Promise.all(tasks);
    expect(results).toHaveLength(5);
    // All tasks completed — order may vary but all should be present
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4]);
  });
});

import { describe, expect, test } from "bun:test";
import { createSemaphore } from "./semaphore.js";

describe("createSemaphore", () => {
  test("allows up to max concurrent operations", async () => {
    const sem = createSemaphore(2);
    let running = 0;
    let maxRunning = 0;

    const task = async (): Promise<void> => {
      await sem.acquire();
      running++;
      maxRunning = Math.max(maxRunning, running);
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
      running--;
      sem.release();
    };

    await Promise.all([task(), task(), task(), task()]);
    expect(maxRunning).toBe(2);
  });

  test("queues operations beyond max", async () => {
    const sem = createSemaphore(1);
    const order: number[] = [];

    const task = async (id: number): Promise<void> => {
      await sem.acquire();
      order.push(id);
      await new Promise((r) => setTimeout(r, 5));
      sem.release();
    };

    await Promise.all([task(1), task(2), task(3)]);
    expect(order).toEqual([1, 2, 3]);
  });

  test("release unblocks waiting acquire", async () => {
    const sem = createSemaphore(1);

    await sem.acquire();

    let acquired = false;
    const pending = sem.acquire().then(() => {
      acquired = true;
    });

    // Not yet acquired
    await new Promise((r) => setTimeout(r, 5));
    expect(acquired).toBe(false);

    // Release unblocks it
    sem.release();
    await pending;
    expect(acquired).toBe(true);

    sem.release();
  });

  test("immediate acquire when under limit", async () => {
    const sem = createSemaphore(3);
    await sem.acquire();
    await sem.acquire();
    await sem.acquire();
    // Should be at limit but all resolved immediately
    sem.release();
    sem.release();
    sem.release();
  });
});

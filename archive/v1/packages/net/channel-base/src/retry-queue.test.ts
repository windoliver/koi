import { describe, expect, mock, test } from "bun:test";
import { createRetryQueue } from "./retry-queue.js";

describe("createRetryQueue", () => {
  test("executes enqueued function", async () => {
    const queue = createRetryQueue();
    const fn = mock(async () => {});

    await queue.enqueue(fn);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  test("size() returns 0 when queue is empty", () => {
    const queue = createRetryQueue();
    expect(queue.size()).toBe(0);
  });

  test("retries on failure with backoff", async () => {
    // let justified: tracks call count
    let calls = 0;
    const fn = async (): Promise<void> => {
      calls += 1;
      if (calls < 3) {
        throw new Error("transient");
      }
    };

    const queue = createRetryQueue({
      retry: {
        maxRetries: 5,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    await queue.enqueue(fn);

    expect(calls).toBe(3);
  });

  test("throws after all retries exhausted", async () => {
    const queue = createRetryQueue({
      retry: {
        maxRetries: 2,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    const fn = async (): Promise<void> => {
      throw new Error("permanent");
    };

    await expect(queue.enqueue(fn)).rejects.toThrow("permanent");
  });

  test("uses extractRetryAfterMs for rate-limit errors", async () => {
    // let justified: tracks call count
    let calls = 0;
    const fn = async (): Promise<void> => {
      calls += 1;
      if (calls === 1) {
        throw { statusCode: 429, retryAfter: 5 };
      }
    };

    const queue = createRetryQueue({
      retry: {
        maxRetries: 3,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 100,
        jitter: false,
      },
      extractRetryAfterMs: (error: unknown) => {
        if (
          typeof error === "object" &&
          error !== null &&
          "statusCode" in error &&
          (error as { statusCode: number }).statusCode === 429
        ) {
          return 1; // 1ms for test speed
        }
        return undefined;
      },
    });

    await queue.enqueue(fn);

    expect(calls).toBe(2);
  });

  test("executes functions sequentially", async () => {
    const order: number[] = [];
    const queue = createRetryQueue();

    const fn1 = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      order.push(1);
    };
    const fn2 = async (): Promise<void> => {
      order.push(2);
    };

    await queue.enqueue(fn1);
    await queue.enqueue(fn2);

    expect(order).toEqual([1, 2]);
  });

  test("concurrent enqueue() callers each wait for their own task", async () => {
    const queue = createRetryQueue();
    const order: number[] = [];

    const fn1 = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push(1);
    };
    const fn2 = async (): Promise<void> => {
      order.push(2);
    };

    // Fire both enqueues concurrently — fn2's promise must NOT resolve before fn2 runs
    const [, p2Settled] = await Promise.all([
      queue.enqueue(fn1),
      queue.enqueue(fn2).then(() => ({ resolved: true, order: [...order] })),
    ]);

    // fn2 caller must have seen fn2 complete (order includes 2)
    expect(p2Settled.resolved).toBe(true);
    expect(p2Settled.order).toContain(2);
    // Both ran in order
    expect(order).toEqual([1, 2]);
  });

  test("concurrent enqueue() propagates errors to the correct caller", async () => {
    const queue = createRetryQueue({
      retry: {
        maxRetries: 0,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    const p1 = queue.enqueue(async () => {
      throw new Error("task-1-fail");
    });
    const p2 = queue.enqueue(async () => {
      // This should succeed
    });

    await expect(p1).rejects.toThrow("task-1-fail");
    // p2 should resolve normally despite p1 failing
    await expect(p2).resolves.toBeUndefined();
  });

  test("continues processing after a failed item throws", async () => {
    const queue = createRetryQueue({
      retry: {
        maxRetries: 0,
        backoffMultiplier: 2,
        initialDelayMs: 1,
        maxBackoffMs: 10,
        jitter: false,
      },
    });

    const successFn = mock(async () => {});

    await expect(
      queue.enqueue(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    // Queue should still be usable after failure
    await queue.enqueue(successFn);
    expect(successFn).toHaveBeenCalledTimes(1);
  });
});

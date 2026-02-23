import { describe, expect, test } from "bun:test";
import { createMessageQueue } from "./message-queue.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function collectAll<T>(iterable: AsyncIterable<T>, maxItems = 100): Promise<readonly T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

async function readWithTimeout<T>(iter: AsyncIterator<T>, timeoutMs = 100): Promise<T | undefined> {
  const result = await Promise.race([
    iter.next(),
    new Promise<{ done: true; value: undefined }>((r) =>
      setTimeout(() => r({ done: true, value: undefined }), timeoutMs),
    ),
  ]);
  if (result.done) return undefined;
  return result.value;
}

// ---------------------------------------------------------------------------
// Basic push/iterate
// ---------------------------------------------------------------------------

describe("createMessageQueue", () => {
  test("push and iterate yields items in order", async () => {
    const queue = createMessageQueue<string>();
    queue.push("a");
    queue.push("b");
    queue.push("c");
    queue.close();

    const items = await collectAll(queue);
    expect(items).toEqual(["a", "b", "c"]);
  });

  test("iterate blocks until push", async () => {
    const queue = createMessageQueue<number>();
    const iter = queue[Symbol.asyncIterator]();

    // Schedule push after a short delay
    setTimeout(() => {
      queue.push(42);
      queue.close();
    }, 10);

    const result = await iter.next();
    expect(result.done).toBe(false);
    expect(result.value).toBe(42);
  });

  test("close unblocks waiting iterator", async () => {
    const queue = createMessageQueue<string>();
    const iter = queue[Symbol.asyncIterator]();

    // Close after a short delay
    setTimeout(() => queue.close(), 10);

    const result = await iter.next();
    expect(result.done).toBe(true);
  });

  test("push after close is a no-op", async () => {
    const queue = createMessageQueue<string>();
    queue.push("before");
    queue.close();
    queue.push("after");

    const items = await collectAll(queue);
    expect(items).toEqual(["before"]);
    expect(queue.size).toBe(0);
  });

  test("close is idempotent", () => {
    const queue = createMessageQueue<string>();
    queue.close();
    queue.close();
    queue.close();
    expect(queue.closed).toBe(true);
  });

  test("size reflects buffer contents", () => {
    const queue = createMessageQueue<string>();
    expect(queue.size).toBe(0);
    queue.push("a");
    expect(queue.size).toBe(1);
    queue.push("b");
    expect(queue.size).toBe(2);
  });

  test("closed is false initially and true after close", () => {
    const queue = createMessageQueue<string>();
    expect(queue.closed).toBe(false);
    queue.close();
    expect(queue.closed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bounded buffer
// ---------------------------------------------------------------------------

describe("bounded buffer", () => {
  test("drops oldest when buffer exceeds maxSize", async () => {
    const queue = createMessageQueue<number>({ maxSize: 3 });
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.push(4); // Should drop 1
    queue.close();

    const items = await collectAll(queue);
    expect(items).toEqual([2, 3, 4]);
  });

  test("size does not exceed maxSize", () => {
    const queue = createMessageQueue<number>({ maxSize: 2 });
    queue.push(1);
    queue.push(2);
    queue.push(3);
    expect(queue.size).toBe(2);
  });

  test("default maxSize is 100", () => {
    const queue = createMessageQueue<number>();
    for (let i = 0; i < 150; i++) {
      queue.push(i);
    }
    // Should have dropped the first 50
    expect(queue.size).toBe(100);
    queue.close();
  });
});

// ---------------------------------------------------------------------------
// Blocking behavior
// ---------------------------------------------------------------------------

describe("blocking behavior", () => {
  test("immediate resolve when consumer is waiting", async () => {
    const queue = createMessageQueue<string>();
    const iter = queue[Symbol.asyncIterator]();

    // Start waiting
    const resultPromise = iter.next();

    // Push resolves the waiting consumer immediately
    queue.push("immediate");

    const result = await resultPromise;
    expect(result.done).toBe(false);
    expect(result.value).toBe("immediate");

    queue.close();
  });

  test("drains buffer before blocking", async () => {
    const queue = createMessageQueue<string>();
    queue.push("buffered-1");
    queue.push("buffered-2");

    const iter = queue[Symbol.asyncIterator]();

    const r1 = await iter.next();
    expect(r1.value).toBe("buffered-1");

    const r2 = await iter.next();
    expect(r2.value).toBe("buffered-2");

    // Now buffer is empty — next call should block
    const timeoutResult = await readWithTimeout(iter, 30);
    expect(timeoutResult).toBeUndefined();

    queue.close();
  });

  test("interleaved push and iterate", async () => {
    const queue = createMessageQueue<number>();
    const collected: number[] = [];

    // Consumer
    const consumer = (async () => {
      for await (const item of queue) {
        collected.push(item);
      }
    })();

    // Producer
    queue.push(1);
    await new Promise<void>((r) => setTimeout(r, 5));
    queue.push(2);
    await new Promise<void>((r) => setTimeout(r, 5));
    queue.push(3);
    queue.close();

    await consumer;

    expect(collected).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  test("empty queue that is immediately closed yields nothing", async () => {
    const queue = createMessageQueue<string>();
    queue.close();

    const items = await collectAll(queue);
    expect(items).toEqual([]);
  });

  test("multiple iterators are not supported (second blocks indefinitely)", async () => {
    const queue = createMessageQueue<string>();
    queue.push("item");
    queue.close();

    const iter1 = queue[Symbol.asyncIterator]();
    const r1 = await iter1.next();
    expect(r1.value).toBe("item");

    // Second iterator — buffer is now empty and queue is closed
    const iter2 = queue[Symbol.asyncIterator]();
    const r2 = await iter2.next();
    expect(r2.done).toBe(true);
  });
});

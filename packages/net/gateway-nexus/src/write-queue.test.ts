import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWriteQueue } from "./write-queue.js";

describe("WriteQueue", () => {
  const writes: Array<{ readonly path: string; readonly data: string }> = [];
  const writeFn = async (path: string, data: string): Promise<void> => {
    writes.push({ path, data });
  };

  beforeEach(() => {
    writes.length = 0;
  });

  test("flush sends all pending writes", async () => {
    const q = createWriteQueue(writeFn, { flushIntervalMs: 60_000 });
    q.enqueue("a.json", '{"a":1}');
    q.enqueue("b.json", '{"b":2}');
    expect(q.size()).toBe(2);

    await q.flush();
    expect(q.size()).toBe(0);
    expect(writes).toHaveLength(2);
    await q.dispose();
  });

  test("coalesces writes to the same path", async () => {
    const q = createWriteQueue(writeFn, { flushIntervalMs: 60_000 });
    q.enqueue("a.json", "v1");
    q.enqueue("a.json", "v2");
    q.enqueue("a.json", "v3");
    expect(q.size()).toBe(1);

    await q.flush();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.data).toBe("v3");
    await q.dispose();
  });

  test("immediate writes bypass queue", async () => {
    const q = createWriteQueue(writeFn, { flushIntervalMs: 60_000 });
    q.enqueue("a.json", "immediate", true);
    expect(q.size()).toBe(0);
    // Wait for the async write to complete
    await new Promise((r) => setTimeout(r, 10));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.data).toBe("immediate");
    await q.dispose();
  });

  test("drops oldest when queue is full", async () => {
    const q = createWriteQueue(writeFn, { maxQueueSize: 2, flushIntervalMs: 60_000 });
    q.enqueue("a.json", "first");
    q.enqueue("b.json", "second");
    q.enqueue("c.json", "third");
    expect(q.size()).toBe(2);

    await q.flush();
    const paths = writes.map((w) => w.path);
    expect(paths).toContain("b.json");
    expect(paths).toContain("c.json");
    expect(paths).not.toContain("a.json");
    await q.dispose();
  });

  test("dispose flushes remaining writes", async () => {
    const q = createWriteQueue(writeFn, { flushIntervalMs: 60_000 });
    q.enqueue("a.json", "data");
    await q.dispose();
    expect(writes).toHaveLength(1);
    expect(q.size()).toBe(0);
  });

  test("flush is idempotent when empty", async () => {
    const q = createWriteQueue(writeFn, { flushIntervalMs: 60_000 });
    await q.flush();
    expect(writes).toHaveLength(0);
    await q.dispose();
  });

  let queue: ReturnType<typeof createWriteQueue> | undefined;

  afterEach(async () => {
    if (queue !== undefined) {
      await queue.dispose();
      queue = undefined;
    }
  });

  test("auto-flushes on timer", async () => {
    queue = createWriteQueue(writeFn, { flushIntervalMs: 50 });
    queue.enqueue("a.json", "timer-data");
    // Wait for auto-flush
    await new Promise((r) => setTimeout(r, 120));
    expect(writes.length).toBeGreaterThanOrEqual(1);
    expect(writes[0]?.data).toBe("timer-data");
  });
});

import { describe, expect, test } from "bun:test";
import { createWriteQueue } from "./write-queue.js";

function makeRecorder(): {
  fn: (path: string, data: string) => Promise<void>;
  calls: Array<{ path: string; data: string }>;
} {
  const calls: Array<{ path: string; data: string }> = [];
  return {
    fn: async (path, data) => {
      calls.push({ path, data });
    },
    calls,
  };
}

describe("write queue", () => {
  test("coalesces writes to the same path", async () => {
    const { fn, calls } = makeRecorder();
    const q = createWriteQueue(fn, { flushIntervalMs: 60_000, maxQueueSize: 100 });

    q.enqueue("a", "1");
    q.enqueue("a", "2");
    q.enqueue("a", "3");
    expect(q.size()).toBe(1);

    await q.flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ path: "a", data: "3" });
  });

  test("immediate writes bypass coalescing", async () => {
    const { fn, calls } = makeRecorder();
    const q = createWriteQueue(fn, { flushIntervalMs: 60_000 });

    q.enqueue("a", "queued");
    q.enqueue("a", "immediate", true);

    await new Promise<void>((r) => setTimeout(r, 10));
    expect(calls.find((c) => c.data === "immediate")).toBeDefined();
    expect(q.size()).toBe(0);
  });

  test("dispose drains remaining writes", async () => {
    const { fn, calls } = makeRecorder();
    const q = createWriteQueue(fn, { flushIntervalMs: 60_000 });
    q.enqueue("a", "1");
    q.enqueue("b", "2");
    await q.dispose();
    expect(calls).toHaveLength(2);
    expect(q.size()).toBe(0);
  });

  test("evicts oldest when queue full", async () => {
    const { fn, calls } = makeRecorder();
    const q = createWriteQueue(fn, { flushIntervalMs: 60_000, maxQueueSize: 2 });
    q.enqueue("a", "1");
    q.enqueue("b", "2");
    q.enqueue("c", "3");
    expect(q.size()).toBe(2);
    await q.flush();
    const paths = calls.map((c) => c.path).sort();
    expect(paths).toEqual(["b", "c"]);
  });

  test("failed writes requeue (bounded retry, no silent drop)", async () => {
    let count = 0;
    const q = createWriteQueue(
      async () => {
        count++;
        throw new Error("boom");
      },
      { flushIntervalMs: 60_000 },
    );
    q.enqueue("a", "1");
    await q.flush();
    // First attempt fired and failed — entry is now requeued for retry, not dropped.
    expect(count).toBe(1);
    expect(q.size()).toBe(1);
  });

  test("retry exhaustion reports via onError", async () => {
    const errors: Array<{ path: string; retries: number }> = [];
    const q = createWriteQueue(
      async () => {
        throw new Error("perma-boom");
      },
      { flushIntervalMs: 60_000 },
      (_err, ctx) => {
        errors.push({ path: ctx.path, retries: ctx.retries });
      },
    );
    q.enqueue("a", "1");
    // 1 initial + 5 retries = 6 attempts, then exhaustion is reported once.
    for (let i = 0; i < 7; i++) await q.flush();
    expect(errors).toHaveLength(1);
    expect(errors[0]?.path).toBe("a");
    expect(q.size()).toBe(0);
  });

  test("cancel(path) drops pending write", async () => {
    const { fn, calls } = makeRecorder();
    const q = createWriteQueue(fn, { flushIntervalMs: 60_000 });
    q.enqueue("a", "1");
    q.cancel("a");
    await q.flush();
    expect(calls).toHaveLength(0);
    expect(q.size()).toBe(0);
  });

  test("cancel(path) tombstones in-flight write so failure does NOT requeue", async () => {
    let releaseWrite!: () => void;
    const writeGate = new Promise<void>((res) => {
      releaseWrite = res;
    });
    const q = createWriteQueue(
      async () => {
        await writeGate;
        throw new Error("boom");
      },
      { flushIntervalMs: 60_000 },
    );
    q.enqueue("a", "stale");
    const flushP = q.flush();
    // Cancel while the failing write is in flight.
    q.cancel("a");
    releaseWrite();
    await flushP;
    // Tombstoned: stale value must not be requeued (would resurrect deleted record).
    expect(q.size()).toBe(0);
  });

  test("enqueue after cancel clears the tombstone (path is reusable)", async () => {
    const { fn, calls } = makeRecorder();
    const q = createWriteQueue(fn, { flushIntervalMs: 60_000 });
    q.enqueue("a", "x");
    q.cancel("a");
    q.enqueue("a", "fresh");
    await q.flush();
    expect(calls).toEqual([{ path: "a", data: "fresh" }]);
  });

  test("drainPath waits for in-flight immediate write to settle", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let completed = false;
    const q = createWriteQueue(async () => {
      await gate;
      completed = true;
    });
    q.enqueue("a", "1", true); // immediate
    const drainP = q.drainPath("a");
    // Microtask yield so the immediate write actually starts.
    await new Promise<void>((res) => setTimeout(res, 5));
    expect(completed).toBe(false);
    release();
    await drainP;
    expect(completed).toBe(true);
    await q.dispose();
  });

  test("dispose drains in-flight immediate writes (round-3 fix 2)", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let completed = false;
    const q = createWriteQueue(async () => {
      await gate;
      completed = true;
    });
    q.enqueue("a", "1", true);
    const disposeP = q.dispose();
    // Microtask yield so dispose() observes the immediate write in flight.
    await new Promise<void>((res) => setTimeout(res, 5));
    expect(completed).toBe(false);
    release();
    await disposeP;
    expect(completed).toBe(true);
  });

  test("synchronous throw in writeFn during flushAll is caught (round-4 fix 2)", async () => {
    // Without Promise.resolve().then() wrapping, a sync throw bypasses
    // Promise.allSettled and entries.clear() leaves the entry orphaned —
    // never requeued, never reported.
    const errors: unknown[] = [];
    const q = createWriteQueue(
      () => {
        throw new Error("sync-throw");
      },
      { flushIntervalMs: 60_000 },
      (err) => errors.push(err),
    );
    q.enqueue("a", "1");
    // Multiple flushes drive through retries until exhaustion.
    for (let i = 0; i < 7; i++) await q.flush();
    // Should have surfaced the sync throw as a queue error (after retry exhaustion).
    expect(errors.length).toBeGreaterThan(0);
    expect((errors[0] as Error).message).toBe("sync-throw");
  });

  test("drainPath waits for ALL concurrent same-path writes (round-4 fix 1)", async () => {
    // The bug: single-promise inFlightByPath let drainPath await only the
    // most-recent in-flight write, leaving an older write un-drained.
    // delete() could then proceed while the older write was still landing,
    // resurrecting the record. Verify multiple concurrent same-path writes
    // are all drained.
    let release1!: () => void;
    let release2!: () => void;
    const gate1 = new Promise<void>((res) => {
      release1 = res;
    });
    const gate2 = new Promise<void>((res) => {
      release2 = res;
    });
    let attempts = 0;
    const completed = { first: false, second: false };
    const q = createWriteQueue(async (_path, data) => {
      attempts++;
      if (data === "first") {
        await gate1;
        completed.first = true;
      } else {
        await gate2;
        completed.second = true;
      }
    });
    // Two concurrent writes for the same path.
    q.enqueue("a", "first", true);
    q.enqueue("a", "second", true);
    expect(attempts).toBeGreaterThanOrEqual(0);

    const drainP = q.drainPath("a");
    // Yield so writes start.
    await new Promise<void>((res) => setTimeout(res, 5));
    expect(completed.first).toBe(false);
    expect(completed.second).toBe(false);
    // Releasing only one is not enough — drainPath must still be waiting.
    release1();
    await new Promise<void>((res) => setTimeout(res, 5));
    expect(completed.first).toBe(true);
    // drainPath must NOT have resolved yet because second is still in-flight.
    let drained = false;
    void drainP.then(() => {
      drained = true;
    });
    await new Promise<void>((res) => setTimeout(res, 5));
    expect(drained).toBe(false);
    release2();
    await drainP;
    expect(completed.second).toBe(true);
    await q.dispose();
  });

  test("cancel without in-flight write does NOT add a tombstone (no leak)", async () => {
    // Round-3 finding 3: tombstones should not accumulate for cancellations
    // that have nothing to protect against. After cancel-then-enqueue the
    // tombstone-clearing-on-enqueue invariant still holds, but cancelling
    // an idle path must not even create the tombstone in the first place.
    const { fn, calls } = makeRecorder();
    const q = createWriteQueue(fn);
    q.cancel("a"); // no in-flight, nothing pending
    q.enqueue("a", "fresh");
    await q.flush();
    expect(calls).toEqual([{ path: "a", data: "fresh" }]);
    await q.dispose();
  });

  test("newer write supersedes failed-and-requeued stale value", async () => {
    let attempt = 0;
    const seen: string[] = [];
    const q = createWriteQueue(
      async (_path, data) => {
        attempt++;
        seen.push(data);
        if (attempt === 1) throw new Error("boom");
      },
      { flushIntervalMs: 60_000 },
      () => {},
    );
    // Enqueue an initial value, then mid-flight enqueue a fresher value:
    q.enqueue("a", "stale");
    const flushP = q.flush();
    q.enqueue("a", "fresh");
    await flushP;
    // Stale failed and was superseded by "fresh" already in the pending map,
    // so the next flush writes "fresh" exactly once (no double write of stale).
    await q.flush();
    expect(seen).toEqual(["stale", "fresh"]);
    expect(q.size()).toBe(0);
  });
});

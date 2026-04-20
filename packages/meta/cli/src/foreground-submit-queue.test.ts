import { describe, expect, test } from "bun:test";
import { createForegroundSubmitQueue } from "./foreground-submit-queue.js";

function createDeferred(): {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
} {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMicrotasks(iterations = 5): Promise<void> {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
  }
}

describe("createForegroundSubmitQueue", () => {
  test("starts first submit immediately and queues a second while busy", async () => {
    const first = createDeferred();
    const calls: string[] = [];
    const queue = createForegroundSubmitQueue({
      run: async (text: string) => {
        calls.push(text);
        if (text === "first") {
          await first.promise;
        }
      },
    });

    expect(await queue.submit("first")).toBe("started");
    expect(await queue.submit("second")).toBe("queued");
    expect(calls).toEqual(["first"]);
    expect(queue.snapshot()).toEqual(["second"]);

    first.resolve();
    await flushMicrotasks();

    expect(calls).toEqual(["first", "second"]);
    expect(queue.snapshot()).toEqual([]);
    expect(queue.isRunning()).toBe(false);
  });

  test("drains queued submits in FIFO order", async () => {
    const first = createDeferred();
    const second = createDeferred();
    const calls: string[] = [];
    const queue = createForegroundSubmitQueue({
      run: async (text: string) => {
        calls.push(text);
        if (text === "first") await first.promise;
        if (text === "second") await second.promise;
      },
    });

    await queue.submit("first");
    await queue.submit("second");
    await queue.submit("third");
    expect(queue.snapshot()).toEqual(["second", "third"]);

    first.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["first", "second"]);
    expect(queue.snapshot()).toEqual(["third"]);

    second.resolve();
    await flushMicrotasks();
    expect(calls).toEqual(["first", "second", "third"]);
    expect(queue.snapshot()).toEqual([]);
  });

  test("clear drops queued submits but does not affect the active run", async () => {
    const first = createDeferred();
    const calls: string[] = [];
    const queue = createForegroundSubmitQueue({
      run: async (text: string) => {
        calls.push(text);
        if (text === "first") {
          await first.promise;
        }
      },
    });

    await queue.submit("first");
    await queue.submit("second");
    await queue.submit("third");

    expect(queue.clear()).toEqual(["second", "third"]);
    expect(queue.snapshot()).toEqual([]);
    expect(queue.isRunning()).toBe(true);

    first.resolve();
    await flushMicrotasks();

    expect(calls).toEqual(["first"]);
    expect(queue.isRunning()).toBe(false);
  });

  test("interruptAndSubmit aborts the active run, clears queued submits, and starts replacement", async () => {
    const first = createDeferred();
    const calls: string[] = [];
    const interrupts: string[] = [];
    const queue = createForegroundSubmitQueue({
      run: async (text: string) => {
        calls.push(text);
        if (text === "first") {
          await first.promise;
        }
      },
      interrupt: async () => {
        interrupts.push("interrupt");
        first.resolve();
      },
    });

    await queue.submit("first");
    await queue.submit("second");

    expect(await queue.interruptAndSubmit("replacement")).toBe("started");
    await flushMicrotasks();

    expect(interrupts).toEqual(["interrupt"]);
    expect(calls).toEqual(["first", "replacement"]);
    expect(queue.snapshot()).toEqual([]);
    expect(queue.isRunning()).toBe(false);
  });
});

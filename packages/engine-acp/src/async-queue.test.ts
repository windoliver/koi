/**
 * Tests for the async queue utility.
 */

import { describe, expect, mock, test } from "bun:test";
import { createAsyncQueue } from "./async-queue.js";

describe("createAsyncQueue", () => {
  test("yields pushed values in order", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.end();

    const results: number[] = [];
    for await (const v of queue) {
      results.push(v);
    }
    expect(results).toEqual([1, 2, 3]);
  });

  test("yields values pushed before consumer", async () => {
    const queue = createAsyncQueue<string>();
    queue.push("a");
    queue.push("b");
    queue.end();

    const iter = queue[Symbol.asyncIterator]();
    expect((await iter.next()).value).toBe("a");
    expect((await iter.next()).value).toBe("b");
    expect((await iter.next()).done).toBe(true);
  });

  test("consumer waits for push", async () => {
    const queue = createAsyncQueue<number>();

    const promise = (async () => {
      const results: number[] = [];
      for await (const v of queue) {
        results.push(v);
      }
      return results;
    })();

    await new Promise((r) => setTimeout(r, 1));
    queue.push(42);
    queue.end();

    const results = await promise;
    expect(results).toEqual([42]);
  });

  test("ignores pushes after end()", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.end();
    queue.push(2); // should be ignored

    const results: number[] = [];
    for await (const v of queue) {
      results.push(v);
    }
    expect(results).toEqual([1]);
  });

  test("double end() is safe", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.end();
    queue.end(); // should not throw or duplicate the done signal

    const results: number[] = [];
    for await (const v of queue) {
      results.push(v);
    }
    expect(results).toEqual([1]);
  });

  test("emits high-watermark warning at 500 items", () => {
    const warnMock = mock(() => {});
    const origWarn = console.warn.bind(console);
    console.warn = warnMock;

    try {
      const queue = createAsyncQueue<number>("test-label");
      // Push 500 items without consuming
      for (let i = 0; i < 500; i++) {
        queue.push(i);
      }
      // Warning should have been emitted exactly once, with expected content
      expect(warnMock).toHaveBeenCalledTimes(1);
      expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("test-label"));
      expect(warnMock).toHaveBeenCalledWith(expect.stringContaining("500"));
    } finally {
      console.warn = origWarn;
    }
  });

  test("no warning before 500 items", () => {
    const warnMock = mock(() => {});
    const origWarn = console.warn.bind(console);
    console.warn = warnMock;

    try {
      const queue = createAsyncQueue<number>();
      for (let i = 0; i < 499; i++) {
        queue.push(i);
      }
      expect(warnMock).not.toHaveBeenCalled();
    } finally {
      console.warn = origWarn;
    }
  });
});

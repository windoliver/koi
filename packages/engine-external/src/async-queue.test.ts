import { describe, expect, test } from "bun:test";
import { createAsyncQueue } from "./async-queue.js";

describe("createAsyncQueue", () => {
  test("push then consume yields values in order", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.end();

    const values: number[] = [];
    for await (const v of queue) {
      values.push(v);
    }
    expect(values).toEqual([1, 2, 3]);
  });

  test("consume then push (blocking) unblocks consumer", async () => {
    const queue = createAsyncQueue<string>();

    const collected = (async () => {
      const values: string[] = [];
      for await (const v of queue) {
        values.push(v);
      }
      return values;
    })();

    // Push after consumer is waiting
    await new Promise((r) => setTimeout(r, 10));
    queue.push("a");
    queue.push("b");
    queue.end();

    const values = await collected;
    expect(values).toEqual(["a", "b"]);
  });

  test("end() signals completion", async () => {
    const queue = createAsyncQueue<number>();
    queue.end();

    const values: number[] = [];
    for await (const v of queue) {
      values.push(v);
    }
    expect(values).toEqual([]);
  });

  test("push after end() is a no-op", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.end();
    queue.push(2); // should be ignored

    const values: number[] = [];
    for await (const v of queue) {
      values.push(v);
    }
    expect(values).toEqual([1]);
  });

  test("interleaved push and consume works correctly", async () => {
    const queue = createAsyncQueue<number>();

    const collected = (async () => {
      const values: number[] = [];
      for await (const v of queue) {
        values.push(v);
      }
      return values;
    })();

    for (const i of [1, 2, 3, 4, 5]) {
      queue.push(i);
      await new Promise((r) => setTimeout(r, 1));
    }
    queue.end();

    const values = await collected;
    expect(values).toEqual([1, 2, 3, 4, 5]);
  });

  test("end() is idempotent", async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.end();
    queue.end(); // second call should be no-op

    const values: number[] = [];
    for await (const v of queue) {
      values.push(v);
    }
    expect(values).toEqual([1]);
  });
});

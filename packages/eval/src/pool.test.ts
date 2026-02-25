import { describe, expect, test } from "bun:test";
import { runPool } from "./pool.js";

describe("runPool", () => {
  test("returns results in order", async () => {
    const tasks = [
      () => Promise.resolve("a"),
      () => Promise.resolve("b"),
      () => Promise.resolve("c"),
    ];
    const results = await runPool(tasks, 3);
    expect(results).toEqual(["a", "b", "c"]);
  });

  test("respects concurrency limit", async () => {
    // let justified: tracking concurrent execution count
    let concurrent = 0;
    // let justified: tracking max observed concurrency
    let maxConcurrent = 0;

    const createTask = (value: string) => async () => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise((resolve) => setTimeout(resolve, 10));
      concurrent -= 1;
      return value;
    };

    const tasks = Array.from({ length: 10 }, (_, i) => createTask(String(i)));
    await runPool(tasks, 3);

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  test("calls onComplete for each result", async () => {
    const completed: string[] = [];
    const tasks = [() => Promise.resolve("a"), () => Promise.resolve("b")];
    await runPool(tasks, 2, (result) => completed.push(result));
    expect(completed).toContain("a");
    expect(completed).toContain("b");
    expect(completed).toHaveLength(2);
  });

  test("propagates errors", async () => {
    const tasks = [() => Promise.resolve("ok"), () => Promise.reject(new Error("fail"))];
    await expect(runPool(tasks, 2)).rejects.toThrow("fail");
  });

  test("handles empty task list", async () => {
    const results = await runPool([], 5);
    expect(results).toEqual([]);
  });

  test("handles concurrency greater than task count", async () => {
    const tasks = [() => Promise.resolve(1), () => Promise.resolve(2)];
    const results = await runPool(tasks, 100);
    expect(results).toEqual([1, 2]);
  });
});

import { describe, expect, test } from "bun:test";
import { createSemaphore } from "./semaphore.js";

describe("createSemaphore", () => {
  test("throws for invalid maxConcurrency", () => {
    expect(() => createSemaphore(0)).toThrow(/positive integer/);
    expect(() => createSemaphore(-1)).toThrow(/positive integer/);
    expect(() => createSemaphore(Number.NaN)).toThrow(/positive integer/);
  });

  test("allows concurrent execution up to limit", async () => {
    const sem = createSemaphore(2);
    const order: number[] = [];

    const p1 = sem.run(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(11);
      return "a";
    });

    const p2 = sem.run(async () => {
      order.push(2);
      await new Promise((r) => setTimeout(r, 50));
      order.push(22);
      return "b";
    });

    const p3 = sem.run(async () => {
      order.push(3);
      return "c";
    });

    const results = await Promise.all([p1, p2, p3]);
    expect(results).toEqual(["a", "b", "c"]);
    // p1 and p2 start immediately (both in the first 2 slots)
    expect(order[0]).toBe(1);
    expect(order[1]).toBe(2);
    // p3 starts only after p1 or p2 finishes
    expect(order.indexOf(3)).toBeGreaterThan(1);
  });

  test("releases slot on error", async () => {
    const sem = createSemaphore(1);

    await expect(
      sem.run(async () => {
        throw new Error("fail");
      }),
    ).rejects.toThrow("fail");

    // Slot should be released — next run should succeed
    const result = await sem.run(async () => "ok");
    expect(result).toBe("ok");
  });

  test("concurrency of 1 serializes execution", async () => {
    const sem = createSemaphore(1);
    const order: string[] = [];

    const p1 = sem.run(async () => {
      order.push("start-1");
      await new Promise((r) => setTimeout(r, 30));
      order.push("end-1");
    });

    const p2 = sem.run(async () => {
      order.push("start-2");
      await new Promise((r) => setTimeout(r, 10));
      order.push("end-2");
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2"]);
  });
});

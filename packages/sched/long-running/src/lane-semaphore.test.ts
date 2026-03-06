import { describe, expect, test } from "bun:test";
import { createLaneSemaphore } from "./lane-semaphore.js";

describe("createLaneSemaphore", () => {
  test("without lanes, behaves as plain semaphore", async () => {
    const gate = createLaneSemaphore(2);
    await gate.acquire();
    expect(gate.activeCount()).toBe(1);
    gate.release();
    expect(gate.activeCount()).toBe(0);
  });

  test("lane limit restricts per-lane concurrency", async () => {
    const lanes = new Map([["fast", 1]]);
    const gate = createLaneSemaphore(5, lanes);

    await gate.acquire("fast");
    expect(gate.activeCount("fast")).toBe(1);

    // Second acquire on same lane should block
    let acquired = false;
    const pending = gate.acquire("fast").then(() => {
      acquired = true;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);

    gate.release("fast");
    await pending;
    expect(acquired).toBe(true);
  });

  test("global limit caps all lanes", async () => {
    const lanes = new Map([
      ["a", 5],
      ["b", 5],
    ]);
    const gate = createLaneSemaphore(2, lanes);

    await gate.acquire("a");
    await gate.acquire("b");
    expect(gate.activeCount()).toBe(2);

    // Third acquire should block on global
    let acquired = false;
    const pending = gate.acquire("a").then(() => {
      acquired = true;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);

    gate.release("b");
    await pending;
    expect(acquired).toBe(true);
  });

  test("unknown lane falls through to global only", async () => {
    const lanes = new Map([["known", 1]]);
    const gate = createLaneSemaphore(3, lanes);

    await gate.acquire("unknown");
    // Global count is 1 (unknown lane has no lane-specific semaphore)
    expect(gate.activeCount()).toBe(1);
    gate.release("unknown");
    expect(gate.activeCount()).toBe(0);
  });
});

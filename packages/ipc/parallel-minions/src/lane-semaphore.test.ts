import { describe, expect, it } from "bun:test";
import { createLaneSemaphore } from "./lane-semaphore.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Delay utility for concurrency timing tests. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLaneSemaphore", () => {
  it("behaves as plain semaphore when no lanes configured", async () => {
    const gate = createLaneSemaphore(2);

    await gate.acquire();
    await gate.acquire();
    expect(gate.activeCount()).toBe(2);

    // Third acquire should block — verify via timeout race
    const blocked = Promise.race([
      gate.acquire().then(() => "acquired"),
      delay(30).then(() => "blocked"),
    ]);
    expect(await blocked).toBe("blocked");

    gate.release();
    expect(gate.activeCount()).toBe(2); // still 2 — slot given to waiter
  });

  it("enforces per-lane limit independently", async () => {
    const gate = createLaneSemaphore(10, new Map([["slow", 2]]));

    await gate.acquire("slow");
    await gate.acquire("slow");
    expect(gate.activeCount("slow")).toBe(2);

    // Third "slow" should block even though global has capacity
    const blocked = Promise.race([
      gate.acquire("slow").then(() => "acquired"),
      delay(30).then(() => "blocked"),
    ]);
    expect(await blocked).toBe("blocked");
  });

  it("enforces global limit across all lanes", async () => {
    const gate = createLaneSemaphore(
      3,
      new Map([
        ["a", 2],
        ["b", 2],
      ]),
    );

    await gate.acquire("a");
    await gate.acquire("a");
    await gate.acquire("b");
    expect(gate.activeCount()).toBe(3);

    // Lane "b" has capacity (1/2) but global is full (3/3)
    const blocked = Promise.race([
      gate.acquire("b").then(() => "acquired"),
      delay(30).then(() => "blocked"),
    ]);
    expect(await blocked).toBe("blocked");
  });

  it("unconfigured lane only gated by global", async () => {
    const gate = createLaneSemaphore(2, new Map([["known", 1]]));

    // "unknown" lane has no per-lane limit — only global applies
    await gate.acquire("unknown");
    await gate.acquire("unknown");
    expect(gate.activeCount()).toBe(2);

    // Global is full
    const blocked = Promise.race([
      gate.acquire("unknown").then(() => "acquired"),
      delay(30).then(() => "blocked"),
    ]);
    expect(await blocked).toBe("blocked");
  });

  it("release frees both lane and global slots", async () => {
    const gate = createLaneSemaphore(2, new Map([["x", 1]]));

    await gate.acquire("x");
    expect(gate.activeCount("x")).toBe(1);
    expect(gate.activeCount()).toBe(1);

    gate.release("x");
    expect(gate.activeCount("x")).toBe(0);
    expect(gate.activeCount()).toBe(0);
  });

  it("FIFO ordering within a lane", async () => {
    const gate = createLaneSemaphore(5, new Map([["lane", 1]]));
    const order: number[] = [];

    await gate.acquire("lane");

    // Queue 3 waiters — they should resolve in FIFO order
    const p1 = gate.acquire("lane").then(() => {
      order.push(1);
    });
    const p2 = gate.acquire("lane").then(() => {
      order.push(2);
    });
    const p3 = gate.acquire("lane").then(() => {
      order.push(3);
    });

    // Release one at a time
    gate.release("lane");
    await p1;
    gate.release("lane");
    await p2;
    gate.release("lane");
    await p3;

    expect(order).toEqual([1, 2, 3]);
  });

  it("lane-full does not block other lanes (starvation prevention)", async () => {
    const gate = createLaneSemaphore(
      10,
      new Map([
        ["slow", 1],
        ["fast", 3],
      ]),
    );

    // Fill "slow" lane
    await gate.acquire("slow");

    // "fast" lane should still be acquirable
    await gate.acquire("fast");
    await gate.acquire("fast");
    expect(gate.activeCount("fast")).toBe(2);

    // "slow" lane blocks
    const slowBlocked = Promise.race([
      gate.acquire("slow").then(() => "acquired"),
      delay(30).then(() => "blocked"),
    ]);
    expect(await slowBlocked).toBe("blocked");

    // "fast" lane still fine
    await gate.acquire("fast");
    expect(gate.activeCount("fast")).toBe(3);
  });

  it("activeCount(lane) returns lane-specific count", async () => {
    const gate = createLaneSemaphore(
      10,
      new Map([
        ["a", 5],
        ["b", 5],
      ]),
    );

    await gate.acquire("a");
    await gate.acquire("a");
    await gate.acquire("b");

    expect(gate.activeCount("a")).toBe(2);
    expect(gate.activeCount("b")).toBe(1);
  });

  it("activeCount() returns global count", async () => {
    const gate = createLaneSemaphore(
      10,
      new Map([
        ["a", 5],
        ["b", 5],
      ]),
    );

    await gate.acquire("a");
    await gate.acquire("b");
    await gate.acquire("b");

    expect(gate.activeCount()).toBe(3);
  });
});

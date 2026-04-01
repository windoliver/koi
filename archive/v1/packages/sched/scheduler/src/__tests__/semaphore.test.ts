import { describe, expect, test } from "bun:test";
import { createSemaphore } from "../semaphore.js";

describe("Semaphore", () => {
  test("acquire succeeds up to maxConcurrent", () => {
    const sem = createSemaphore(3);
    expect(sem.acquire()).toBe(true);
    expect(sem.acquire()).toBe(true);
    expect(sem.acquire()).toBe(true);
    expect(sem.acquire()).toBe(false);
  });

  test("release allows next acquire", () => {
    const sem = createSemaphore(1);
    expect(sem.acquire()).toBe(true);
    expect(sem.acquire()).toBe(false);

    sem.release();
    expect(sem.acquire()).toBe(true);
  });

  test("available count is accurate", () => {
    const sem = createSemaphore(3);
    expect(sem.available()).toBe(3);

    sem.acquire();
    expect(sem.available()).toBe(2);

    sem.acquire();
    expect(sem.available()).toBe(1);

    sem.release();
    expect(sem.available()).toBe(2);
  });

  test("release below zero is a no-op", () => {
    const sem = createSemaphore(2);
    sem.release();
    // Should not go negative — available should still be max
    expect(sem.available()).toBe(2);
  });

  test("throws on maxConcurrent < 1", () => {
    expect(() => createSemaphore(0)).toThrow("maxConcurrent must be at least 1");
  });
});

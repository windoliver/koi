import { describe, expect, it } from "bun:test";
import { createSemaphore } from "./semaphore.js";

describe("createSemaphore", () => {
  it("allows up to maxConcurrent acquires", () => {
    const s = createSemaphore(2);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(true);
    expect(s.tryAcquire()).toBe(false);
  });

  it("release frees a slot", () => {
    const s = createSemaphore(1);
    expect(s.tryAcquire()).toBe(true);
    s.release();
    expect(s.tryAcquire()).toBe(true);
  });

  it("available tracks free slots", () => {
    const s = createSemaphore(3);
    expect(s.available()).toBe(3);
    s.tryAcquire();
    expect(s.available()).toBe(2);
  });

  it("release is a no-op when nothing acquired", () => {
    const s = createSemaphore(1);
    s.release();
    expect(s.available()).toBe(1);
  });
});

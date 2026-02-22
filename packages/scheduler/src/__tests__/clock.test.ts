import { describe, expect, test } from "bun:test";
import { createFakeClock, createSystemClock } from "../clock.js";

describe("FakeClock", () => {
  test("now returns start time initially", () => {
    const clock = createFakeClock(1000);
    expect(clock.now()).toBe(1000);
    expect(clock.currentTime()).toBe(1000);
  });

  test("tick advances time", () => {
    const clock = createFakeClock(0);
    clock.tick(500);
    expect(clock.now()).toBe(500);
  });

  test("setTimeout fires callback after delay", () => {
    const clock = createFakeClock(0);
    let called = false; // let: set to true when callback fires
    clock.setTimeout(() => {
      called = true;
    }, 100);

    clock.tick(50);
    expect(called).toBe(false);

    clock.tick(60);
    expect(called).toBe(true);
  });

  test("clearTimeout prevents callback from firing", () => {
    const clock = createFakeClock(0);
    let called = false; // let: set to true when callback fires
    const id = clock.setTimeout(() => {
      called = true;
    }, 100);

    clock.clearTimeout(id);
    clock.tick(200);
    expect(called).toBe(false);
  });

  test("setInterval fires repeatedly", () => {
    const clock = createFakeClock(0);
    let count = 0; // let: incremented on each callback
    clock.setInterval(() => {
      count += 1;
    }, 100);

    clock.tick(350);
    expect(count).toBe(3);
  });

  test("clearInterval stops repeating", () => {
    const clock = createFakeClock(0);
    let count = 0; // let: incremented on each callback
    const id = clock.setInterval(() => {
      count += 1;
    }, 100);

    clock.tick(250);
    expect(count).toBe(2);

    clock.clearInterval(id);
    clock.tick(200);
    expect(count).toBe(2);
  });
});

describe("SystemClock", () => {
  test("now returns current time", () => {
    const clock = createSystemClock();
    const before = Date.now();
    const now = clock.now();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  test("setTimeout and clearTimeout work", () => {
    const clock = createSystemClock();
    let called = false; // let: set on callback
    const id = clock.setTimeout(() => {
      called = true;
    }, 10_000);
    clock.clearTimeout(id);
    // Not testing timing — just verifying no errors
    expect(called).toBe(false);
  });

  test("setInterval and clearInterval work", () => {
    const clock = createSystemClock();
    let count = 0; // let: incremented on callback
    const id = clock.setInterval(() => {
      count += 1;
    }, 10_000);
    clock.clearInterval(id);
    // Not testing timing — just verifying no errors
    expect(count).toBe(0);
  });
});

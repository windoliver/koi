import { beforeEach, describe, expect, test } from "bun:test";
import type { FakeClock } from "./clock.js";
import { createFakeClock } from "./clock.js";

describe("createFakeClock", () => {
  let clock: FakeClock;

  beforeEach(() => {
    clock = createFakeClock(0);
  });

  test("now() returns start time initially", () => {
    expect(clock.now()).toBe(0);
  });

  test("advance updates current time", () => {
    clock.advance(1000);
    expect(clock.now()).toBe(1000);
  });

  // setTimeout tests

  test("setTimeout fires callback at correct time", () => {
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 500);
    clock.advance(499);
    expect(fired).toBe(false);
    clock.advance(1);
    expect(fired).toBe(true);
  });

  test("setTimeout fires callback when advancing past fire time", () => {
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 100);
    clock.advance(500);
    expect(fired).toBe(true);
  });

  test("setTimeout clear cancels pending timer", () => {
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 100);
    handle.clear();
    clock.advance(200);
    expect(fired).toBe(false);
  });

  test("multiple setTimeout fire in chronological order", () => {
    const order: number[] = [];
    clock.setTimeout(() => {
      order.push(2);
    }, 200);
    clock.setTimeout(() => {
      order.push(1);
    }, 100);
    clock.setTimeout(() => {
      order.push(3);
    }, 300);
    clock.advance(300);
    expect(order).toEqual([1, 2, 3]);
  });

  // setInterval tests

  test("setInterval fires repeatedly", () => {
    let count = 0;
    clock.setInterval(() => {
      count += 1;
    }, 100);
    clock.advance(350);
    expect(count).toBe(3); // fires at 100, 200, 300
  });

  test("setInterval clear stops future firings", () => {
    let count = 0;
    const handle = clock.setInterval(() => {
      count += 1;
    }, 100);
    clock.advance(250); // fires at 100, 200
    handle.clear();
    clock.advance(200); // would fire at 300, 400 — but cancelled
    expect(count).toBe(2);
  });

  // pendingCount tests

  test("pendingCount reflects active timers", () => {
    expect(clock.pendingCount()).toBe(0);
    clock.setTimeout(() => {}, 100);
    clock.setInterval(() => {}, 200);
    expect(clock.pendingCount()).toBe(2);
  });

  test("pendingCount decreases when one-shot timer fires", () => {
    clock.setTimeout(() => {}, 100);
    expect(clock.pendingCount()).toBe(1);
    clock.advance(100);
    expect(clock.pendingCount()).toBe(0);
  });

  test("pendingCount reflects cancelled timers after advance", () => {
    const handle = clock.setTimeout(() => {}, 100);
    expect(clock.pendingCount()).toBe(1);
    handle.clear();
    expect(clock.pendingCount()).toBe(0);
  });

  test("interval timer persists in pendingCount until cleared", () => {
    const handle = clock.setInterval(() => {}, 100);
    clock.advance(500);
    expect(clock.pendingCount()).toBe(1); // interval still active
    handle.clear();
    clock.advance(0); // trigger cleanup
    expect(clock.pendingCount()).toBe(0);
  });

  // Edge cases

  test("timer scheduled during callback fires in same advance", () => {
    let secondFired = false;
    clock.setTimeout(() => {
      clock.setTimeout(() => {
        secondFired = true;
      }, 50);
    }, 100);
    clock.advance(200);
    expect(secondFired).toBe(true);
  });

  test("custom start time is respected", () => {
    const c = createFakeClock(1000);
    expect(c.now()).toBe(1000);
    c.advance(500);
    expect(c.now()).toBe(1500);
  });
});

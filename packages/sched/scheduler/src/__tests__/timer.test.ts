import { describe, expect, test } from "bun:test";
import { createFakeClock } from "../clock.js";
import { createPeriodicTimer } from "../timer.js";

describe("createPeriodicTimer", () => {
  test("fires callback at interval", () => {
    const clock = createFakeClock(0);
    let count = 0; // let: incremented on each callback
    createPeriodicTimer(clock, 100, () => {
      count += 1;
    });

    clock.tick(350);
    expect(count).toBe(3);
  });

  test("stop prevents further callbacks", () => {
    const clock = createFakeClock(0);
    let count = 0; // let: incremented on each callback
    const timer = createPeriodicTimer(clock, 100, () => {
      count += 1;
    });

    clock.tick(250);
    expect(count).toBe(2);

    timer.stop();
    clock.tick(200);
    expect(count).toBe(2);
  });

  test("double stop is a no-op", () => {
    const clock = createFakeClock(0);
    const timer = createPeriodicTimer(clock, 100, () => {});

    timer.stop();
    timer.stop(); // should not throw
  });

  test("throws on interval < 1ms", () => {
    const clock = createFakeClock(0);
    expect(() => createPeriodicTimer(clock, 0, () => {})).toThrow("Interval must be at least 1ms");
  });

  test("asyncDispose stops the timer", async () => {
    const clock = createFakeClock(0);
    let count = 0; // let: incremented on each callback
    const timer = createPeriodicTimer(clock, 100, () => {
      count += 1;
    });

    clock.tick(150);
    expect(count).toBe(1);

    await timer[Symbol.asyncDispose]();
    clock.tick(200);
    expect(count).toBe(1);
  });
});

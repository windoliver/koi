import { describe, expect, it } from "bun:test";
import { createFakeClock } from "./clock.js";
import { createPeriodicTimer } from "./timer.js";

describe("createPeriodicTimer", () => {
  it("fires on each interval", () => {
    const clock = createFakeClock(0);
    let count = 0;
    const timer = createPeriodicTimer(
      100,
      () => {
        count++;
      },
      clock,
    );
    timer.start();
    clock.tick(300);
    expect(count).toBe(3);
  });

  it("stops after dispose", async () => {
    const clock = createFakeClock(0);
    let count = 0;
    const timer = createPeriodicTimer(
      100,
      () => {
        count++;
      },
      clock,
    );
    timer.start();
    clock.tick(100);
    await timer[Symbol.asyncDispose]();
    clock.tick(200);
    expect(count).toBe(1);
  });
});

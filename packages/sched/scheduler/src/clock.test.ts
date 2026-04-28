import { describe, expect, it } from "bun:test";
import { createFakeClock } from "./clock.js";

describe("FakeClock", () => {
  it("starts at initialTime", () => {
    const c = createFakeClock(1000);
    expect(c.now()).toBe(1000);
  });

  it("tick advances time and fires timers", () => {
    const c = createFakeClock(0);
    let fired = false;
    c.setTimeout(() => {
      fired = true;
    }, 100);
    c.tick(99);
    expect(fired).toBe(false);
    c.tick(1);
    expect(fired).toBe(true);
  });

  it("clearTimeout cancels a pending timer", () => {
    const c = createFakeClock(0);
    let fired = false;
    const id = c.setTimeout(() => {
      fired = true;
    }, 100);
    c.clearTimeout(id);
    c.tick(200);
    expect(fired).toBe(false);
  });

  it("fires timers in chronological order", () => {
    const c = createFakeClock(0);
    const order: number[] = [];
    c.setTimeout(() => order.push(2), 200);
    c.setTimeout(() => order.push(1), 100);
    c.tick(200);
    expect(order).toEqual([1, 2]);
  });
});

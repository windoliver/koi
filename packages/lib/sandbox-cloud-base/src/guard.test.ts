import { describe, expect, test } from "bun:test";
import { createDestroyGuard } from "./guard.js";

describe("createDestroyGuard", () => {
  test("allows checks before destroy and flips state on first destroy", () => {
    const guard = createDestroyGuard("sandbox-cloud");

    expect(guard.destroyed).toBe(false);
    expect(() => guard.check("execute")).not.toThrow();
    expect(guard.destroy()).toBe(true);
    expect(guard.destroyed).toBe(true);
  });

  test("returns false after the first destroy and rejects later checks", () => {
    const guard = createDestroyGuard("sandbox-cloud");

    guard.destroy();

    expect(guard.destroy()).toBe(false);
    expect(() => guard.check("execute")).toThrow("sandbox-cloud: cannot call execute() after destroy()");
  });
});

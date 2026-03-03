import { describe, expect, test } from "bun:test";
import { createDestroyGuard } from "./guard.js";

describe("createDestroyGuard", () => {
  test("check does not throw when not destroyed", () => {
    const guard = createDestroyGuard("test");
    expect(() => guard.check("exec")).not.toThrow();
    expect(() => guard.check("readFile")).not.toThrow();
  });

  test("check throws after markDestroyed", () => {
    const guard = createDestroyGuard("e2b");
    guard.markDestroyed();
    expect(() => guard.check("exec")).toThrow("e2b: cannot call exec() after destroy()");
  });

  test("includes method name in error message", () => {
    const guard = createDestroyGuard("vercel");
    guard.markDestroyed();
    expect(() => guard.check("writeFile")).toThrow(
      "vercel: cannot call writeFile() after destroy()",
    );
  });

  test("isDestroyed returns false initially", () => {
    const guard = createDestroyGuard("test");
    expect(guard.isDestroyed()).toBe(false);
  });

  test("isDestroyed returns true after markDestroyed", () => {
    const guard = createDestroyGuard("test");
    guard.markDestroyed();
    expect(guard.isDestroyed()).toBe(true);
  });

  test("markDestroyed is idempotent", () => {
    const guard = createDestroyGuard("test");
    guard.markDestroyed();
    guard.markDestroyed();
    expect(guard.isDestroyed()).toBe(true);
    expect(() => guard.check("exec")).toThrow();
  });
});

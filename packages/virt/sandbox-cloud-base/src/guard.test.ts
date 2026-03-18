import { describe, expect, test } from "bun:test";
import { createDestroyGuard, createInstanceGuard } from "./guard.js";

describe("createDestroyGuard (backward compat)", () => {
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

describe("createInstanceGuard tri-state", () => {
  test("state starts as active", () => {
    const guard = createInstanceGuard("test");
    expect(guard.state()).toBe("active");
  });

  test("markDetached transitions active to detached", () => {
    const guard = createInstanceGuard("test");
    guard.markDetached();
    expect(guard.state()).toBe("detached");
  });

  test("check throws with detach message after markDetached", () => {
    const guard = createInstanceGuard("e2b");
    guard.markDetached();
    expect(() => guard.check("exec")).toThrow("e2b: cannot call exec() after detach()");
  });

  test("detach then destroy transitions to destroyed", () => {
    const guard = createInstanceGuard("test");
    guard.markDetached();
    guard.markDestroyed();
    expect(guard.state()).toBe("destroyed");
    expect(guard.isDestroyed()).toBe(true);
  });

  test("markDetached is idempotent", () => {
    const guard = createInstanceGuard("test");
    guard.markDetached();
    guard.markDetached();
    expect(guard.state()).toBe("detached");
  });

  test("markDetached is no-op when already destroyed", () => {
    const guard = createInstanceGuard("test");
    guard.markDestroyed();
    guard.markDetached();
    expect(guard.state()).toBe("destroyed");
  });

  test("markDestroyed from active skips detached", () => {
    const guard = createInstanceGuard("test");
    guard.markDestroyed();
    expect(guard.state()).toBe("destroyed");
    expect(() => guard.check("exec")).toThrow("destroy");
  });
});

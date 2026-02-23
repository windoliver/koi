import { describe, expect, test } from "bun:test";
import { createPromotedExecutor } from "./promoted-executor.js";

describe("createPromotedExecutor", () => {
  const executor = createPromotedExecutor();

  test("returns sync value", async () => {
    const result = await executor.execute("return 42;", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(42);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("returns async value", async () => {
    const result = await executor.execute("return Promise.resolve(42);", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(42);
    }
  });

  test("returns sync throw as CRASH", async () => {
    const result = await executor.execute('throw new Error("boom");', {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("boom");
      expect(result.error.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("returns async throw as CRASH", async () => {
    const result = await executor.execute(
      'return Promise.reject(new Error("async boom"));',
      {},
      5_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("async boom");
    }
  });

  test("returns undefined output", async () => {
    const result = await executor.execute("return undefined;", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBeUndefined();
    }
  });

  test("passes input to function", async () => {
    const result = await executor.execute("return input.x + input.y;", { x: 3, y: 7 }, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(10);
    }
  });

  test("classifies non-Error throw as CRASH", async () => {
    const result = await executor.execute('throw "string error";', {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("string error");
    }
  });

  test("handles non-serializable return", async () => {
    const result = await executor.execute("return { fn: () => {} };", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBeDefined();
      expect(typeof (result.value.output as Record<string, unknown>).fn).toBe("function");
    }
  });

  test("caches compiled functions for same code", async () => {
    const code = "return input.val * 2;";
    const result1 = await executor.execute(code, { val: 5 }, 5_000);
    const result2 = await executor.execute(code, { val: 10 }, 5_000);

    expect(result1.ok).toBe(true);
    expect(result2.ok).toBe(true);
    if (result1.ok && result2.ok) {
      expect(result1.value.output).toBe(10);
      expect(result2.value.output).toBe(20);
    }
  });

  test("classifies Permission denied as PERMISSION", async () => {
    const result = await executor.execute('throw new Error("Permission denied");', {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PERMISSION");
    }
  });
});

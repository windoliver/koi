import { describe, expect, test } from "bun:test";
import { createAsyncWasmExecutor } from "./async-executor.js";

const TIMEOUT_MS = 5_000;

describe("createAsyncWasmExecutor", () => {
  const executor = createAsyncWasmExecutor();

  test("evaluates a simple expression", async () => {
    const result = await executor.execute("1 + 2", undefined, TIMEOUT_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(3);
    }
  });

  test("injects input parameter", async () => {
    const result = await executor.execute("input.x * 2", { x: 21 }, TIMEOUT_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(42);
    }
  });

  test("calls an async host function (appears sync to guest)", async () => {
    const hostFunctions = new Map([
      ["__echo", async (argsJson: string): Promise<string> => argsJson],
    ]);

    // Host functions appear synchronous to guest — no await needed.
    // Use expression value (last expression result) instead of return.
    const code = `
      var __result = __echo(JSON.stringify({ hello: "world" }));
      JSON.parse(__result);
    `;
    const result = await executor.execute(code, undefined, TIMEOUT_MS, hostFunctions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ hello: "world" });
    }
  });

  test("supports multiple sequential host function calls", async () => {
    // Justified `let`: counter incremented in async host function callback.
    let callCount = 0;
    const hostFunctions = new Map([
      [
        "__increment",
        async (_argsJson: string): Promise<string> => {
          callCount++;
          return JSON.stringify(callCount);
        },
      ],
    ]);

    const code = `
      var __a = __increment("");
      var __b = __increment("");
      var __c = __increment("");
      JSON.parse(__a) + JSON.parse(__b) + JSON.parse(__c);
    `;
    const result = await executor.execute(code, undefined, TIMEOUT_MS, hostFunctions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 1 + 2 + 3 = 6
      expect(result.value.output).toBe(6);
    }
    expect(callCount).toBe(3);
  });

  test("supports multiple distinct host functions", async () => {
    const hostFunctions = new Map([
      [
        "__add",
        async (argsJson: string): Promise<string> => {
          const { a, b } = JSON.parse(argsJson) as { a: number; b: number };
          return JSON.stringify(a + b);
        },
      ],
      [
        "__multiply",
        async (argsJson: string): Promise<string> => {
          const { a, b } = JSON.parse(argsJson) as { a: number; b: number };
          return JSON.stringify(a * b);
        },
      ],
    ]);

    const code = `
      var __sum = JSON.parse(__add(JSON.stringify({ a: 3, b: 4 })));
      var __product = JSON.parse(__multiply(JSON.stringify({ a: 3, b: 4 })));
      ({ sum: __sum, product: __product });
    `;
    const result = await executor.execute(code, undefined, TIMEOUT_MS, hostFunctions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ sum: 7, product: 12 });
    }
  });

  test("enforces timeout on infinite loop", async () => {
    const result = await executor.execute("while(true) {}", undefined, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
    }
  });

  test("enforces memory limit", async () => {
    const smallExecutor = createAsyncWasmExecutor({ memoryLimitBytes: 256 * 1024 });
    const code = `
      var arr = [];
      for (var i = 0; i < 1_000_000; i++) arr.push("x".repeat(1000));
      arr.length;
    `;
    const result = await smallExecutor.execute(code, undefined, TIMEOUT_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("OOM");
    }
  });

  test("classifies thrown errors as CRASH", async () => {
    const result = await executor.execute('throw new Error("boom")', undefined, TIMEOUT_MS);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("boom");
    }
  });

  test("propagates host function errors to guest", async () => {
    const hostFunctions = new Map([
      [
        "__failing",
        async (_argsJson: string): Promise<string> => {
          throw new Error("host error");
        },
      ],
    ]);

    const code = `
      var __out;
      try {
        __failing("");
        __out = "should not reach";
      } catch (e) {
        __out = "caught: " + e.message;
      }
      __out;
    `;
    const result = await executor.execute(code, undefined, TIMEOUT_MS, hostFunctions);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.output).toBe("string");
      expect(result.value.output as string).toContain("caught:");
    }
  });

  test("isolates state between calls", async () => {
    await executor.execute("globalThis.__testVal = 42;", undefined, TIMEOUT_MS);
    const result = await executor.execute("typeof globalThis.__testVal;", undefined, TIMEOUT_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe("undefined");
    }
  });

  test("handles void expression returning undefined", async () => {
    const result = await executor.execute("var x = 1;", undefined, TIMEOUT_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBeUndefined();
    }
  });

  test("reports duration in result", async () => {
    const result = await executor.execute("1 + 1", undefined, TIMEOUT_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("handles no host functions (undefined map)", async () => {
    const result = await executor.execute("42", undefined, TIMEOUT_MS);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(42);
    }
  });
});

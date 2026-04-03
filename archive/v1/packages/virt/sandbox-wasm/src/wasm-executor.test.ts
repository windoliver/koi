import { describe, expect, test } from "bun:test";
import type { ChildSpanRecord } from "@koi/execution-context";
import { runWithSpanRecorder } from "@koi/execution-context";
import { createWasmSandboxExecutor } from "./wasm-executor.js";

describe("createWasmSandboxExecutor", () => {
  const executor = createWasmSandboxExecutor();

  test("evaluates simple expression", async () => {
    const result = await executor.execute("1 + 2", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(3);
      expect(result.value.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("passes input parameter", async () => {
    const result = await executor.execute("input.x + input.y", { x: 3, y: 7 }, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(10);
    }
  });

  test("returns object output", async () => {
    const result = await executor.execute("({name: 'test', value: 42})", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual({ name: "test", value: 42 });
    }
  });

  test("returns undefined for void expression", async () => {
    const result = await executor.execute("void 0", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBeUndefined();
    }
  });

  test("returns null output", async () => {
    const result = await executor.execute("null", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBeNull();
    }
  });

  test("returns array output", async () => {
    const result = await executor.execute("[1, 2, 3]", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toEqual([1, 2, 3]);
    }
  });

  test("classifies infinite loop as TIMEOUT", async () => {
    const result = await executor.execute("while(true){}", {}, 100);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  test("classifies memory exhaustion as OOM", async () => {
    const smallExecutor = createWasmSandboxExecutor({ memoryLimitBytes: 256 * 1024 });
    const result = await smallExecutor.execute(
      "const a=[]; while(true) a.push(new Array(10000));",
      {},
      5_000,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("OOM");
    }
  });

  test("classifies thrown Error as CRASH", async () => {
    const result = await executor.execute('throw new Error("boom")', {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
      expect(result.error.message).toBe("boom");
    }
  });

  test("classifies syntax error as CRASH", async () => {
    const result = await executor.execute("{{{", {}, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
    }
  });

  test("reports memory usage", async () => {
    const result = await executor.execute("1 + 1", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.memoryUsedBytes).toBeGreaterThan(0);
    }
  });

  test("does not expose host globals", async () => {
    const checks = ["typeof fetch", "typeof process", "typeof require", "typeof Bun"];
    for (const code of checks) {
      const result = await executor.execute(code, {}, 5_000);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.output).toBe("undefined");
      }
    }
  });

  test("isolates state between calls", async () => {
    const set = await executor.execute("globalThis.leaked = 42; globalThis.leaked", {}, 5_000);
    expect(set.ok).toBe(true);
    if (set.ok) {
      expect(set.value.output).toBe(42);
    }

    const read = await executor.execute("typeof globalThis.leaked", {}, 5_000);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.output).toBe("undefined");
    }
  });

  test("supports concurrent execution", async () => {
    const results = await Promise.all([
      executor.execute("input.v * 2", { v: 5 }, 5_000),
      executor.execute("input.v * 3", { v: 7 }, 5_000),
    ]);

    expect(results[0]?.ok).toBe(true);
    expect(results[1]?.ok).toBe(true);
    if (results[0]?.ok && results[1]?.ok) {
      expect(results[0].value.output).toBe(10);
      expect(results[1].value.output).toBe(21);
    }
  });

  test("measures durationMs", async () => {
    const result = await executor.execute("1", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value.durationMs).toBe("number");
      expect(result.value.durationMs).toBeGreaterThan(0);
    }
  });

  test("handles string input", async () => {
    const result = await executor.execute("input", "hello", 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe("hello");
    }
  });

  test("handles null input", async () => {
    const result = await executor.execute("input", null, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBeNull();
    }
  });

  test("returns CRASH for non-serializable input (BigInt)", async () => {
    const result = await executor.execute("input", BigInt(42), 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
    }
  });

  test("returns CRASH for circular input", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = await executor.execute("input", circular, 5_000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("CRASH");
    }
  });

  test("handles undefined input", async () => {
    const result = await executor.execute("typeof input", undefined, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe("undefined");
    }
  });

  // --- span recording ---

  test("records span on successful execution", async () => {
    const spans: ChildSpanRecord[] = [];
    const recorder = {
      record: (span: ChildSpanRecord): void => {
        spans.push(span);
      },
    };

    await runWithSpanRecorder(recorder, () => executor.execute("1 + 2", {}, 5_000));

    expect(spans).toHaveLength(1);
    expect(spans[0]?.label).toBe("sandbox-wasm");
    expect(spans[0]?.durationMs).toBeGreaterThan(0);
    expect(spans[0]?.error).toBeUndefined();
    expect(spans[0]?.metadata?.memoryUsedBytes).toBeGreaterThan(0);
  });

  test("records span with error on failure", async () => {
    const spans: ChildSpanRecord[] = [];
    const recorder = {
      record: (span: ChildSpanRecord): void => {
        spans.push(span);
      },
    };

    await runWithSpanRecorder(recorder, () =>
      executor.execute("throw new Error('boom')", {}, 5_000),
    );

    expect(spans).toHaveLength(1);
    expect(spans[0]?.label).toBe("sandbox-wasm");
    expect(spans[0]?.error).toBeDefined();
    expect(spans[0]?.durationMs).toBeGreaterThan(0);
  });

  test("does not record span outside recorder scope", async () => {
    // No runWithSpanRecorder — should not throw, just silently skip
    const result = await executor.execute("1 + 1", {}, 5_000);
    expect(result.ok).toBe(true);
  });

  test("respects custom config", async () => {
    const custom = createWasmSandboxExecutor({
      memoryLimitBytes: 2 * 1024 * 1024,
      maxStackSizeBytes: 256 * 1024,
    });
    const result = await custom.execute("1 + 1", {}, 5_000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.output).toBe(2);
    }
  });
});

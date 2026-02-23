/**
 * Unit tests for worker pure functions.
 */

import { describe, expect, test } from "bun:test";
import { executeCode, formatError, formatResult, parseHostMessage } from "./worker-logic.js";

// ---------------------------------------------------------------------------
// parseHostMessage
// ---------------------------------------------------------------------------

describe("parseHostMessage", () => {
  test("parses valid execute message", () => {
    const raw = { kind: "execute", code: "return 1", input: { x: 42 }, timeoutMs: 5000 };
    const result = parseHostMessage(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.code).toBe("return 1");
    expect(result.value.input).toEqual({ x: 42 });
    expect(result.value.timeoutMs).toBe(5000);
  });

  test("rejects unknown kind", () => {
    const raw = { kind: "run", code: "return 1", input: {}, timeoutMs: 5000 };
    const result = parseHostMessage(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects missing fields", () => {
    const result = parseHostMessage({ kind: "execute" });
    expect(result.ok).toBe(false);
  });

  test("rejects wrong types", () => {
    const raw = { kind: "execute", code: 123, input: {}, timeoutMs: "5000" };
    const result = parseHostMessage(raw);
    expect(result.ok).toBe(false);
  });

  test("rejects null input", () => {
    const result = parseHostMessage(null);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object input", () => {
    const result = parseHostMessage("execute");
    expect(result.ok).toBe(false);
  });

  test("error message includes details", () => {
    const result = parseHostMessage({});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// executeCode
// ---------------------------------------------------------------------------

describe("executeCode", () => {
  test("executes simple return", async () => {
    const result = await executeCode("return 42", {}, 5000);
    expect(result.kind).toBe("result");
    if (result.kind !== "result") return;
    expect(result.output).toBe(42);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("receives input parameter", async () => {
    const result = await executeCode("return input.x + input.y", { x: 10, y: 20 }, 5000);
    expect(result.kind).toBe("result");
    if (result.kind !== "result") return;
    expect(result.output).toBe(30);
  });

  test("handles thrown error", async () => {
    const result = await executeCode('throw new Error("oops")', {}, 5000);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.code).toBe("CRASH");
    expect(result.message).toContain("oops");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("handles async code (returned promise)", async () => {
    const result = await executeCode("return Promise.resolve(99)", {}, 5000);
    expect(result.kind).toBe("result");
    if (result.kind !== "result") return;
    expect(result.output).toBe(99);
  });

  test("handles undefined return", async () => {
    const result = await executeCode("const x = 1;", {}, 5000);
    expect(result.kind).toBe("result");
    if (result.kind !== "result") return;
    expect(result.output).toBeUndefined();
  });

  test("handles object return", async () => {
    const result = await executeCode('return { name: "test", value: 42 }', {}, 5000);
    expect(result.kind).toBe("result");
    if (result.kind !== "result") return;
    expect(result.output).toEqual({ name: "test", value: 42 });
  });

  test("handles syntax error in code", async () => {
    const result = await executeCode("return {{{", {}, 5000);
    expect(result.kind).toBe("error");
    if (result.kind !== "error") return;
    expect(result.code).toBe("CRASH");
  });
});

// ---------------------------------------------------------------------------
// formatResult
// ---------------------------------------------------------------------------

describe("formatResult", () => {
  test("creates result message with correct shape", () => {
    const result = formatResult(42, 100);
    expect(result.kind).toBe("result");
    expect(result.output).toBe(42);
    expect(result.durationMs).toBe(100);
  });

  test("propagates null output", () => {
    const result = formatResult(null, 0);
    expect(result.output).toBeNull();
  });

  test("propagates durationMs", () => {
    const result = formatResult("ok", 999);
    expect(result.durationMs).toBe(999);
  });
});

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

describe("formatError", () => {
  test("creates error message with correct shape", () => {
    const result = formatError("TIMEOUT", "timed out", 5000);
    expect(result.kind).toBe("error");
    expect(result.code).toBe("TIMEOUT");
    expect(result.message).toBe("timed out");
    expect(result.durationMs).toBe(5000);
  });

  test("accepts all error codes", () => {
    const codes = ["TIMEOUT", "OOM", "PERMISSION", "CRASH"] as const;
    for (const code of codes) {
      const result = formatError(code, "err", 0);
      expect(result.code).toBe(code);
    }
  });

  test("propagates message and durationMs", () => {
    const result = formatError("CRASH", "something broke", 42);
    expect(result.message).toBe("something broke");
    expect(result.durationMs).toBe(42);
  });
});

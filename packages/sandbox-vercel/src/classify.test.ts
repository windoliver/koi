import { describe, expect, test } from "bun:test";
import { classifyVercelError } from "./classify.js";

describe("classifyVercelError", () => {
  test("classifies 'sandbox unavailable' as CRASH", () => {
    const result = classifyVercelError(new Error("sandbox unavailable"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("classifies 'microvm failed' as CRASH", () => {
    const result = classifyVercelError(new Error("microvm failed to start"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("falls back to base classifier for timeout", () => {
    const result = classifyVercelError(new Error("execution timed out"), 100);
    expect(result.code).toBe("TIMEOUT");
  });

  test("falls back to base classifier for OOM", () => {
    const result = classifyVercelError(new Error("out of memory"), 100);
    expect(result.code).toBe("OOM");
  });

  test("falls back to CRASH for unknown errors", () => {
    const result = classifyVercelError(new Error("something unexpected"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("preserves durationMs", () => {
    const result = classifyVercelError(new Error("fail"), 42);
    expect(result.durationMs).toBe(42);
  });
});

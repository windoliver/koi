import { describe, expect, test } from "bun:test";
import { classifyDaytonaError } from "./classify.js";

describe("classifyDaytonaError", () => {
  test("classifies 'workspace not found' as CRASH", () => {
    const result = classifyDaytonaError(new Error("workspace not found"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("classifies 'sandbox not ready' as CRASH", () => {
    const result = classifyDaytonaError(new Error("sandbox not ready"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("falls back to base classifier for timeout", () => {
    const result = classifyDaytonaError(new Error("execution timed out"), 100);
    expect(result.code).toBe("TIMEOUT");
  });

  test("falls back to base classifier for OOM", () => {
    const result = classifyDaytonaError(new Error("out of memory"), 100);
    expect(result.code).toBe("OOM");
  });

  test("falls back to CRASH for unknown errors", () => {
    const result = classifyDaytonaError(new Error("something unexpected"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("preserves durationMs", () => {
    const result = classifyDaytonaError(new Error("fail"), 42);
    expect(result.durationMs).toBe(42);
  });
});

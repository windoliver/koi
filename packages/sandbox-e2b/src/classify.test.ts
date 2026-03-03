import { describe, expect, test } from "bun:test";
import { classifyE2bError } from "./classify.js";

describe("classifyE2bError", () => {
  test("classifies 'template not found' as CRASH", () => {
    const result = classifyE2bError(new Error("template not found"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("classifies 'sandbox not found' as CRASH", () => {
    const result = classifyE2bError(new Error("sandbox not found"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("classifies 'rate limit' as CRASH", () => {
    const result = classifyE2bError(new Error("rate limit exceeded"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("classifies 'too many requests' as CRASH", () => {
    const result = classifyE2bError(new Error("too many requests"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("falls back to base classifier for timeout", () => {
    const result = classifyE2bError(new Error("execution timed out"), 100);
    expect(result.code).toBe("TIMEOUT");
  });

  test("falls back to base classifier for OOM", () => {
    const result = classifyE2bError(new Error("out of memory"), 100);
    expect(result.code).toBe("OOM");
  });

  test("falls back to CRASH for unknown errors", () => {
    const result = classifyE2bError(new Error("something unexpected"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("preserves durationMs", () => {
    const result = classifyE2bError(new Error("fail"), 42);
    expect(result.durationMs).toBe(42);
  });
});

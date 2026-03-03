import { describe, expect, test } from "bun:test";
import { classifyCloudflareError } from "./classify.js";

describe("classifyCloudflareError", () => {
  test("classifies 'worker limit' as CRASH", () => {
    const result = classifyCloudflareError(new Error("worker limit reached"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("classifies 'script too large' as CRASH", () => {
    const result = classifyCloudflareError(new Error("script too large"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("falls back to base classifier for timeout", () => {
    const result = classifyCloudflareError(new Error("execution timed out"), 100);
    expect(result.code).toBe("TIMEOUT");
  });

  test("falls back to base classifier for OOM", () => {
    const result = classifyCloudflareError(new Error("out of memory"), 100);
    expect(result.code).toBe("OOM");
  });

  test("falls back to CRASH for unknown errors", () => {
    const result = classifyCloudflareError(new Error("something unexpected"), 100);
    expect(result.code).toBe("CRASH");
  });

  test("preserves durationMs", () => {
    const result = classifyCloudflareError(new Error("fail"), 42);
    expect(result.durationMs).toBe(42);
  });
});

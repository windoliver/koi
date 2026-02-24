import { describe, expect, test } from "bun:test";
import { validateFeedbackLoopConfig } from "./config.js";

describe("validateFeedbackLoopConfig", () => {
  const passingValidator = { name: "v1", validate: () => ({ valid: true as const }) };

  test("accepts valid config with validators", () => {
    const result = validateFeedbackLoopConfig({ validators: [passingValidator] });
    expect(result.ok).toBe(true);
  });

  test("accepts empty config (no-op middleware)", () => {
    const result = validateFeedbackLoopConfig({});
    expect(result.ok).toBe(true);
  });

  test("accepts config with all fields", () => {
    const result = validateFeedbackLoopConfig({
      validators: [passingValidator],
      gates: [passingValidator],
      toolValidators: [passingValidator],
      toolGates: [passingValidator],
      retry: { validation: { maxAttempts: 5, delayMs: 100 }, transport: { maxAttempts: 2 } },
      repairStrategy: { buildRetryRequest: () => ({ messages: [] }) },
      onRetry: () => {},
      onGateFail: () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateFeedbackLoopConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined config", () => {
    const result = validateFeedbackLoopConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object config", () => {
    const result = validateFeedbackLoopConfig("string");
    expect(result.ok).toBe(false);
  });

  test("rejects validators that are not an array", () => {
    const result = validateFeedbackLoopConfig({ validators: "not-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("validators");
  });

  test("rejects validator without name", () => {
    const result = validateFeedbackLoopConfig({
      validators: [{ validate: () => ({ valid: true }) }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("name");
  });

  test("rejects validator without validate function", () => {
    const result = validateFeedbackLoopConfig({ validators: [{ name: "v1" }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("validate");
  });

  test("rejects gates with invalid entries", () => {
    const result = validateFeedbackLoopConfig({ gates: [{ name: 123 }] });
    expect(result.ok).toBe(false);
  });

  test("rejects negative retry.validation.maxAttempts", () => {
    const result = validateFeedbackLoopConfig({ retry: { validation: { maxAttempts: -1 } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxAttempts");
  });

  test("rejects negative retry.validation.delayMs", () => {
    const result = validateFeedbackLoopConfig({ retry: { validation: { delayMs: -5 } } });
    expect(result.ok).toBe(false);
  });

  test("rejects negative retry.transport.baseDelayMs", () => {
    const result = validateFeedbackLoopConfig({ retry: { transport: { baseDelayMs: -1 } } });
    expect(result.ok).toBe(false);
  });

  test("rejects negative retry.transport.maxDelayMs", () => {
    const result = validateFeedbackLoopConfig({ retry: { transport: { maxDelayMs: -1 } } });
    expect(result.ok).toBe(false);
  });

  test("rejects non-object retry config", () => {
    const result = validateFeedbackLoopConfig({ retry: "bad" });
    expect(result.ok).toBe(false);
  });

  test("rejects repairStrategy without buildRetryRequest", () => {
    const result = validateFeedbackLoopConfig({ repairStrategy: {} });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("buildRetryRequest");
  });

  test("all errors are non-retryable", () => {
    const result = validateFeedbackLoopConfig(null);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });

  test("accepts zero for retry values", () => {
    const result = validateFeedbackLoopConfig({
      retry: { validation: { maxAttempts: 0, delayMs: 0 }, transport: { maxAttempts: 0 } },
    });
    expect(result.ok).toBe(true);
  });
});

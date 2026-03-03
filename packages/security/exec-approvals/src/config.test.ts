import { describe, expect, test } from "bun:test";
import { DEFAULT_APPROVAL_TIMEOUT_MS, validateExecApprovalsConfig } from "./config.js";

const noop = async () => ({ kind: "allow_once" as const });

describe("DEFAULT_APPROVAL_TIMEOUT_MS", () => {
  test("is 30_000", () => {
    expect(DEFAULT_APPROVAL_TIMEOUT_MS).toBe(30_000);
  });
});

describe("validateExecApprovalsConfig", () => {
  const validConfig = {
    rules: { allow: [], deny: [], ask: [] },
    onAsk: noop,
  };

  test("returns ok for valid config", () => {
    const result = validateExecApprovalsConfig(validConfig);
    expect(result.ok).toBe(true);
  });

  test("returns error for null", () => {
    const result = validateExecApprovalsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  test("returns error for undefined", () => {
    const result = validateExecApprovalsConfig(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error for non-object", () => {
    const result = validateExecApprovalsConfig("string");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns error when rules is missing", () => {
    const result = validateExecApprovalsConfig({ onAsk: noop });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("rules");
  });

  test("returns error when rules is not an object", () => {
    const result = validateExecApprovalsConfig({ rules: "bad", onAsk: noop });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("rules");
  });

  test("returns error when rules.allow is missing", () => {
    const result = validateExecApprovalsConfig({
      rules: { deny: [], ask: [] },
      onAsk: noop,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("allow");
  });

  test("returns error when rules.allow is not an array", () => {
    const result = validateExecApprovalsConfig({
      rules: { allow: "bad", deny: [], ask: [] },
      onAsk: noop,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns ok when onAsk is omitted (optional)", () => {
    const result = validateExecApprovalsConfig({
      rules: { allow: [], deny: [], ask: [] },
    });
    expect(result.ok).toBe(true);
  });

  test("returns error when onAsk is not a function", () => {
    const result = validateExecApprovalsConfig({
      rules: { allow: [], deny: [], ask: [] },
      onAsk: "not-a-function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("onAsk");
    }
  });

  test("returns error when approvalTimeoutMs is zero", () => {
    const result = validateExecApprovalsConfig({ ...validConfig, approvalTimeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("approvalTimeoutMs");
  });

  test("returns error when approvalTimeoutMs is negative", () => {
    const result = validateExecApprovalsConfig({ ...validConfig, approvalTimeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("approvalTimeoutMs");
  });

  test("returns error when approvalTimeoutMs is not a number", () => {
    const result = validateExecApprovalsConfig({ ...validConfig, approvalTimeoutMs: "fast" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("returns ok when approvalTimeoutMs is a positive number", () => {
    const result = validateExecApprovalsConfig({ ...validConfig, approvalTimeoutMs: 5000 });
    expect(result.ok).toBe(true);
  });

  test("returns ok with optional store provided", () => {
    const result = validateExecApprovalsConfig({
      ...validConfig,
      store: { load: async () => ({ allow: [], deny: [] }), save: async () => {} },
    });
    expect(result.ok).toBe(true);
  });

  test("retryable is false for VALIDATION errors", () => {
    const result = validateExecApprovalsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});

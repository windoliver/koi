/**
 * Unit tests for guardrails config validation.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { validateGuardrailsConfig } from "./config.js";

const validRule = {
  name: "test-rule",
  schema: z.object({ message: z.string() }),
  target: "modelOutput",
  action: "block",
};

describe("validateGuardrailsConfig", () => {
  test("accepts valid config with minimal fields", () => {
    const result = validateGuardrailsConfig({ rules: [validRule] });
    expect(result.ok).toBe(true);
  });

  test("accepts config with all optional fields", () => {
    const result = validateGuardrailsConfig({
      rules: [validRule],
      retry: { maxAttempts: 3 },
      maxBufferSize: 1024,
      onViolation: () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with toolOutput target", () => {
    const result = validateGuardrailsConfig({
      rules: [{ ...validRule, target: "toolOutput" }],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts config with all action types", () => {
    for (const action of ["block", "warn", "retry"]) {
      const result = validateGuardrailsConfig({
        rules: [{ ...validRule, action }],
      });
      expect(result.ok).toBe(true);
    }
  });

  test("accepts config with parseMode", () => {
    for (const parseMode of ["json", "text"]) {
      const result = validateGuardrailsConfig({
        rules: [{ ...validRule, parseMode }],
      });
      expect(result.ok).toBe(true);
    }
  });

  test("rejects null config", () => {
    const result = validateGuardrailsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  test("rejects config without rules", () => {
    const result = validateGuardrailsConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("rules");
    }
  });

  test("rejects empty rules array", () => {
    const result = validateGuardrailsConfig({ rules: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("non-empty");
    }
  });

  test("rejects rule without name", () => {
    const result = validateGuardrailsConfig({
      rules: [{ schema: z.string(), target: "modelOutput", action: "block" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("name");
    }
  });

  test("rejects rule with empty name", () => {
    const result = validateGuardrailsConfig({
      rules: [{ name: "", schema: z.string(), target: "modelOutput", action: "block" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("name");
    }
  });

  test("rejects duplicate rule names", () => {
    const result = validateGuardrailsConfig({
      rules: [validRule, { ...validRule, action: "warn" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Duplicate");
      expect(result.error.message).toContain("test-rule");
    }
  });

  test("rejects rule without schema", () => {
    const result = validateGuardrailsConfig({
      rules: [{ name: "test", target: "modelOutput", action: "block" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("schema");
    }
  });

  test("rejects rule with invalid target", () => {
    const result = validateGuardrailsConfig({
      rules: [{ ...validRule, target: "invalid" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("target");
    }
  });

  test("rejects rule with invalid action", () => {
    const result = validateGuardrailsConfig({
      rules: [{ ...validRule, action: "invalid" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("action");
    }
  });

  test("rejects rule with invalid parseMode", () => {
    const result = validateGuardrailsConfig({
      rules: [{ ...validRule, parseMode: "xml" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("parseMode");
    }
  });

  test("rejects invalid retry.maxAttempts (zero)", () => {
    const result = validateGuardrailsConfig({
      rules: [validRule],
      retry: { maxAttempts: 0 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxAttempts");
    }
  });

  test("rejects invalid retry.maxAttempts (negative)", () => {
    const result = validateGuardrailsConfig({
      rules: [validRule],
      retry: { maxAttempts: -1 },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxAttempts");
    }
  });

  test("rejects non-object retry", () => {
    const result = validateGuardrailsConfig({
      rules: [validRule],
      retry: "invalid",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("retry");
    }
  });

  test("rejects invalid maxBufferSize (zero)", () => {
    const result = validateGuardrailsConfig({
      rules: [validRule],
      maxBufferSize: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxBufferSize");
    }
  });

  test("rejects invalid maxBufferSize (NaN)", () => {
    const result = validateGuardrailsConfig({
      rules: [validRule],
      maxBufferSize: Number.NaN,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxBufferSize");
    }
  });

  test("rejects non-function onViolation", () => {
    const result = validateGuardrailsConfig({
      rules: [validRule],
      onViolation: "not a function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("onViolation");
    }
  });

  test("all errors have VALIDATION code", () => {
    const invalidConfigs = [null, {}, { rules: [] }, { rules: [{}] }];
    for (const config of invalidConfigs) {
      const result = validateGuardrailsConfig(config);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.retryable).toBe(false);
      }
    }
  });
});

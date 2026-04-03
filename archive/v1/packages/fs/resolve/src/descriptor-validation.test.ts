/**
 * Tests for descriptor validation helpers.
 */

import { describe, expect, test } from "bun:test";
import { RETRYABLE_DEFAULTS } from "@koi/core/errors";
import {
  validateOptionalDescriptorOptions,
  validateRequiredDescriptorOptions,
} from "./descriptor-validation.js";

// ---------------------------------------------------------------------------
// validateOptionalDescriptorOptions (lenient — null/undefined → {})
// ---------------------------------------------------------------------------

describe("validateOptionalDescriptorOptions", () => {
  test("returns ok with empty object for undefined", () => {
    const result = validateOptionalDescriptorOptions(undefined, "Test");
    expect(result).toEqual({ ok: true, value: {} });
  });

  test("returns ok with empty object for null", () => {
    const result = validateOptionalDescriptorOptions(null, "Test");
    expect(result).toEqual({ ok: true, value: {} });
  });

  test("returns ok for empty object", () => {
    const result = validateOptionalDescriptorOptions({}, "Test");
    expect(result).toEqual({ ok: true, value: {} });
  });

  test("returns ok for object with properties", () => {
    const result = validateOptionalDescriptorOptions({ foo: 1 }, "Test");
    expect(result).toEqual({ ok: true, value: { foo: 1 } });
  });

  test("returns error for string", () => {
    const result = validateOptionalDescriptorOptions("string", "Test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toBe("Test options must be an object");
      expect(result.error.retryable).toBe(RETRYABLE_DEFAULTS.VALIDATION);
    }
  });

  test("returns error for number", () => {
    const result = validateOptionalDescriptorOptions(42, "Test");
    expect(result.ok).toBe(false);
  });

  test("returns error for boolean", () => {
    const result = validateOptionalDescriptorOptions(true, "Test");
    expect(result.ok).toBe(false);
  });

  test("returns error for array", () => {
    const result = validateOptionalDescriptorOptions([], "Test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Test options must be an object");
    }
  });

  test("returns error for zero", () => {
    const result = validateOptionalDescriptorOptions(0, "Test");
    expect(result.ok).toBe(false);
  });

  test("returns error for empty string", () => {
    const result = validateOptionalDescriptorOptions("", "Test");
    expect(result.ok).toBe(false);
  });

  test("includes label in error message", () => {
    const result = validateOptionalDescriptorOptions("bad", "MyEngine");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("MyEngine options must be an object");
    }
  });
});

// ---------------------------------------------------------------------------
// validateRequiredDescriptorOptions (strict — null/undefined → error)
// ---------------------------------------------------------------------------

describe("validateRequiredDescriptorOptions", () => {
  test("returns error for undefined", () => {
    const result = validateRequiredDescriptorOptions(undefined, "Test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toBe("Test options must be an object");
      expect(result.error.retryable).toBe(RETRYABLE_DEFAULTS.VALIDATION);
    }
  });

  test("returns error for null", () => {
    const result = validateRequiredDescriptorOptions(null, "Test");
    expect(result.ok).toBe(false);
  });

  test("returns ok for empty object", () => {
    const result = validateRequiredDescriptorOptions({}, "Test");
    expect(result).toEqual({ ok: true, value: {} });
  });

  test("returns ok for object with properties", () => {
    const result = validateRequiredDescriptorOptions({ foo: 1 }, "Test");
    expect(result).toEqual({ ok: true, value: { foo: 1 } });
  });

  test("returns error for string", () => {
    const result = validateRequiredDescriptorOptions("string", "Test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toBe("Test options must be an object");
    }
  });

  test("returns error for number", () => {
    const result = validateRequiredDescriptorOptions(42, "Test");
    expect(result.ok).toBe(false);
  });

  test("returns error for boolean", () => {
    const result = validateRequiredDescriptorOptions(true, "Test");
    expect(result.ok).toBe(false);
  });

  test("returns error for array", () => {
    const result = validateRequiredDescriptorOptions([], "Test");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Test options must be an object");
    }
  });

  test("returns error for zero", () => {
    const result = validateRequiredDescriptorOptions(0, "Test");
    expect(result.ok).toBe(false);
  });

  test("returns error for empty string", () => {
    const result = validateRequiredDescriptorOptions("", "Test");
    expect(result.ok).toBe(false);
  });

  test("includes label in error message", () => {
    const result = validateRequiredDescriptorOptions("bad", "Audit");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toBe("Audit options must be an object");
    }
  });
});

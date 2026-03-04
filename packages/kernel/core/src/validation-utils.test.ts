import { describe, expect, test } from "bun:test";
import { isProcessState, validateNonEmpty } from "./validation-utils.js";

describe("isProcessState", () => {
  test("returns true for all valid process states", () => {
    for (const state of ["created", "running", "waiting", "suspended", "idle", "terminated"]) {
      expect(isProcessState(state)).toBe(true);
    }
  });

  test("returns false for invalid strings", () => {
    expect(isProcessState("")).toBe(false);
    expect(isProcessState("RUNNING")).toBe(false);
    expect(isProcessState("unknown")).toBe(false);
    expect(isProcessState("paused")).toBe(false);
  });
});

describe("validateNonEmpty", () => {
  test("returns ok for non-empty strings", () => {
    const result = validateNonEmpty("hello", "Test");
    expect(result.ok).toBe(true);
  });

  test("returns VALIDATION error for empty string", () => {
    const result = validateNonEmpty("", "Field");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toBe("Field must not be empty");
    }
  });

  test("includes name in error message", () => {
    const result = validateNonEmpty("", "Agent ID");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Agent ID");
    }
  });
});

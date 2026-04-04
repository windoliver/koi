import { describe, expect, test } from "bun:test";
import { DEFAULT_EXFILTRATION_GUARD_CONFIG, validateExfiltrationGuardConfig } from "../config.js";

describe("validateExfiltrationGuardConfig", () => {
  test("returns defaults when called with undefined", () => {
    const result = validateExfiltrationGuardConfig(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(DEFAULT_EXFILTRATION_GUARD_CONFIG);
    }
  });

  test("returns defaults when called with empty object", () => {
    const result = validateExfiltrationGuardConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.action).toBe("block");
      expect(result.value.maxStringLength).toBe(100_000);
      expect(result.value.scanToolInput).toBe(true);
      expect(result.value.scanModelOutput).toBe(true);
    }
  });

  test("accepts valid action values", () => {
    for (const action of ["block", "redact", "warn"] as const) {
      const result = validateExfiltrationGuardConfig({ action });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.action).toBe(action);
      }
    }
  });

  test("rejects invalid action", () => {
    const result = validateExfiltrationGuardConfig({
      action: "invalid" as "block",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Invalid exfiltration action");
    }
  });

  test("rejects zero maxStringLength", () => {
    const result = validateExfiltrationGuardConfig({ maxStringLength: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects negative maxStringLength", () => {
    const result = validateExfiltrationGuardConfig({ maxStringLength: -1 });
    expect(result.ok).toBe(false);
  });

  test("accepts custom maxStringLength", () => {
    const result = validateExfiltrationGuardConfig({ maxStringLength: 50_000 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxStringLength).toBe(50_000);
    }
  });

  test("accepts onDetection callback", () => {
    const cb = () => {};
    const result = validateExfiltrationGuardConfig({ onDetection: cb });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.onDetection).toBe(cb);
    }
  });

  test("allows scan flags to be toggled off", () => {
    const result = validateExfiltrationGuardConfig({
      scanToolInput: false,
      scanModelOutput: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.scanToolInput).toBe(false);
      expect(result.value.scanModelOutput).toBe(false);
    }
  });
});

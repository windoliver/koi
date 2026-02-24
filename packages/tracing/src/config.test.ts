import { describe, expect, test } from "bun:test";
import { validateConfig } from "./config.js";

describe("validateConfig", () => {
  test("returns ok for valid empty config object", () => {
    const result = validateConfig({});
    expect(result.ok).toBe(true);
  });

  test("returns ok for config with all valid fields", () => {
    const result = validateConfig({
      serviceName: "my-service",
      captureContent: true,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.serviceName).toBe("my-service");
      expect(result.value.captureContent).toBe(true);
    }
  });

  test("returns error for null config", () => {
    const result = validateConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null");
    }
  });

  test("returns error for undefined config", () => {
    const result = validateConfig(undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns error for non-string serviceName", () => {
    const result = validateConfig({ serviceName: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("serviceName");
    }
  });

  test("returns error for non-boolean captureContent", () => {
    const result = validateConfig({ captureContent: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("captureContent");
    }
  });

  test("returns error for non-object config (number)", () => {
    const result = validateConfig(42);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

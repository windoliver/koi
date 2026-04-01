import { describe, expect, test } from "bun:test";
import { validateReportConfig } from "./config.js";

describe("validateReportConfig", () => {
  test("accepts empty object (all fields optional)", () => {
    const result = validateReportConfig({});
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with maxActions", () => {
    const result = validateReportConfig({ maxActions: 100 });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with summarizerTimeoutMs", () => {
    const result = validateReportConfig({ summarizerTimeoutMs: 5000 });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateReportConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects undefined config", () => {
    const result = validateReportConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object config", () => {
    const result = validateReportConfig("string");
    expect(result.ok).toBe(false);
  });

  test("rejects maxActions <= 0", () => {
    const result = validateReportConfig({ maxActions: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxActions");
    }
  });

  test("rejects negative maxActions", () => {
    const result = validateReportConfig({ maxActions: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-number maxActions", () => {
    const result = validateReportConfig({ maxActions: "100" });
    expect(result.ok).toBe(false);
  });

  test("rejects summarizerTimeoutMs <= 0", () => {
    const result = validateReportConfig({ summarizerTimeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("summarizerTimeoutMs");
    }
  });

  test("rejects non-number summarizerTimeoutMs", () => {
    const result = validateReportConfig({ summarizerTimeoutMs: "5000" });
    expect(result.ok).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { validateToolSelectorConfig } from "./config.js";

describe("validateToolSelectorConfig", () => {
  const validSelectTools = async () => ["tool1"];

  test("validates selectTools is a function", () => {
    const result = validateToolSelectorConfig({ selectTools: "not-a-function" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("selectTools");
    }
  });

  test("rejects non-object config", () => {
    expect(validateToolSelectorConfig(null).ok).toBe(false);
    expect(validateToolSelectorConfig(undefined).ok).toBe(false);
    expect(validateToolSelectorConfig("string").ok).toBe(false);
    expect(validateToolSelectorConfig(42).ok).toBe(false);
  });

  test("accepts valid config with all optional fields", () => {
    const result = validateToolSelectorConfig({
      selectTools: validSelectTools,
      alwaysInclude: ["tool-a"],
      maxTools: 15,
      minTools: 3,
      extractQuery: () => "query",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with only required fields", () => {
    const result = validateToolSelectorConfig({ selectTools: validSelectTools });
    expect(result.ok).toBe(true);
  });

  test("rejects negative maxTools", () => {
    const result = validateToolSelectorConfig({
      selectTools: validSelectTools,
      maxTools: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxTools");
    }
  });

  test("rejects zero maxTools", () => {
    const result = validateToolSelectorConfig({
      selectTools: validSelectTools,
      maxTools: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer maxTools", () => {
    const result = validateToolSelectorConfig({
      selectTools: validSelectTools,
      maxTools: 3.5,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative minTools", () => {
    const result = validateToolSelectorConfig({
      selectTools: validSelectTools,
      minTools: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("minTools");
    }
  });

  test("accepts zero minTools", () => {
    const result = validateToolSelectorConfig({
      selectTools: validSelectTools,
      minTools: 0,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects non-array alwaysInclude", () => {
    const result = validateToolSelectorConfig({
      selectTools: validSelectTools,
      alwaysInclude: "not-an-array",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("alwaysInclude");
    }
  });

  test("rejects non-function extractQuery", () => {
    const result = validateToolSelectorConfig({
      selectTools: validSelectTools,
      extractQuery: "not-a-function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("extractQuery");
    }
  });
});

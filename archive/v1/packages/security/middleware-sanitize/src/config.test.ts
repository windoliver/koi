import { describe, expect, test } from "bun:test";
import { validateSanitizeConfig } from "./config.js";
import type { SanitizeRule } from "./types.js";

const validRule: SanitizeRule = {
  name: "test",
  pattern: /test/i,
  action: { kind: "strip", replacement: "" },
};

describe("validateSanitizeConfig", () => {
  test("accepts valid config with rules", () => {
    const result = validateSanitizeConfig({ rules: [validRule] });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with presets", () => {
    const result = validateSanitizeConfig({ presets: ["prompt-injection"] });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with both rules and presets", () => {
    const result = validateSanitizeConfig({
      rules: [validRule],
      presets: ["control-chars"],
    });
    expect(result.ok).toBe(true);
  });

  test("accepts all optional fields", () => {
    const result = validateSanitizeConfig({
      rules: [validRule],
      streamBufferSize: 512,
      sanitizeToolInput: false,
      sanitizeToolOutput: true,
      jsonWalkMaxDepth: 5,
      onSanitization: () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateSanitizeConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-null object");
  });

  test("rejects non-object config", () => {
    const result = validateSanitizeConfig("string");
    expect(result.ok).toBe(false);
  });

  test("rejects config without rules or presets", () => {
    const result = validateSanitizeConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("at least one of");
  });

  test("rejects non-array rules", () => {
    const result = validateSanitizeConfig({ rules: "not-array" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("array");
  });

  test("rejects rule without name", () => {
    const result = validateSanitizeConfig({
      rules: [{ pattern: /x/, action: { kind: "strip", replacement: "" } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("name");
  });

  test("rejects rule with empty name", () => {
    const result = validateSanitizeConfig({
      rules: [{ name: "", pattern: /x/, action: { kind: "strip", replacement: "" } }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects rule without RegExp pattern", () => {
    const result = validateSanitizeConfig({
      rules: [{ name: "r", pattern: "not-regex", action: { kind: "strip", replacement: "" } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("RegExp");
  });

  test("rejects rule with g flag on pattern", () => {
    const result = validateSanitizeConfig({
      rules: [{ name: "r", pattern: /test/g, action: { kind: "strip", replacement: "" } }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("'g' flag");
  });

  test("rejects rule without action", () => {
    const result = validateSanitizeConfig({ rules: [{ name: "r", pattern: /x/ }] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("action");
  });

  test("rejects non-array presets", () => {
    const result = validateSanitizeConfig({ presets: "not-array" });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid preset names", () => {
    const result = validateSanitizeConfig({ presets: ["not-a-preset"] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("valid preset names");
  });

  test("rejects non-number streamBufferSize", () => {
    const result = validateSanitizeConfig({ rules: [validRule], streamBufferSize: "big" });
    expect(result.ok).toBe(false);
  });

  test("rejects zero streamBufferSize", () => {
    const result = validateSanitizeConfig({ rules: [validRule], streamBufferSize: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects Infinity streamBufferSize", () => {
    const result = validateSanitizeConfig({ rules: [validRule], streamBufferSize: Infinity });
    expect(result.ok).toBe(false);
  });

  test("rejects negative streamBufferSize", () => {
    const result = validateSanitizeConfig({ rules: [validRule], streamBufferSize: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer jsonWalkMaxDepth", () => {
    const result = validateSanitizeConfig({ rules: [validRule], jsonWalkMaxDepth: 3.5 });
    expect(result.ok).toBe(false);
  });

  test("rejects zero jsonWalkMaxDepth", () => {
    const result = validateSanitizeConfig({ rules: [validRule], jsonWalkMaxDepth: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-boolean sanitizeToolInput", () => {
    const result = validateSanitizeConfig({ rules: [validRule], sanitizeToolInput: 1 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-boolean sanitizeToolOutput", () => {
    const result = validateSanitizeConfig({ rules: [validRule], sanitizeToolOutput: "yes" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-function onSanitization", () => {
    const result = validateSanitizeConfig({ rules: [validRule], onSanitization: "callback" });
    expect(result.ok).toBe(false);
  });

  test("all validation errors have VALIDATION code", () => {
    const result = validateSanitizeConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.retryable).toBe(false);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { DEFAULT_REDACTION_CONFIG, validateRedactionConfig } from "./config.js";
import type { RedactionConfig } from "./types.js";

describe("validateRedactionConfig", () => {
  test("returns defaults for undefined config", () => {
    const result = validateRedactionConfig(undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxDepth).toBe(10);
      expect(result.value.maxStringLength).toBe(100_000);
      expect(result.value.censor).toBe("redact");
      expect(result.value.patterns.length).toBe(13);
    }
  });

  test("returns defaults for empty object", () => {
    const result = validateRedactionConfig({});
    expect(result.ok).toBe(true);
  });

  test("rejects invalid maxDepth", () => {
    const result = validateRedactionConfig({ maxDepth: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid maxStringLength", () => {
    const result = validateRedactionConfig({ maxStringLength: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects invalid censor", () => {
    // Runtime validation for untrusted input (e.g., parsed from YAML)
    const result = validateRedactionConfig({
      censor: "invalid",
    } as unknown as Partial<RedactionConfig>);
    expect(result.ok).toBe(false);
  });

  test("rejects invalid fieldCensor", () => {
    // Runtime validation for untrusted input
    const result = validateRedactionConfig({
      fieldCensor: 42,
    } as unknown as Partial<RedactionConfig>);
    expect(result.ok).toBe(false);
  });

  test("accepts valid partial config", () => {
    const result = validateRedactionConfig({
      maxDepth: 5,
      censor: "mask",
      fieldNames: ["secret"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.maxDepth).toBe(5);
      expect(result.value.censor).toBe("mask");
      expect(result.value.fieldNames).toEqual(["secret"]);
    }
  });

  test("accepts custom censor function", () => {
    const result = validateRedactionConfig({
      censor: () => "***",
    });
    expect(result.ok).toBe(true);
  });
});

describe("DEFAULT_REDACTION_CONFIG", () => {
  test("has 13 patterns", () => {
    expect(DEFAULT_REDACTION_CONFIG.patterns.length).toBe(13);
  });

  test("has default sensitive fields", () => {
    expect(DEFAULT_REDACTION_CONFIG.fieldNames.length).toBeGreaterThan(20);
  });

  test("uses redact censor", () => {
    expect(DEFAULT_REDACTION_CONFIG.censor).toBe("redact");
  });
});

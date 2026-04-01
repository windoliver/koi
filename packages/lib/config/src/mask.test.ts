import { describe, expect, test } from "bun:test";
import { maskConfig, SENSITIVE_PATTERN } from "./mask.js";

describe("SENSITIVE_PATTERN", () => {
  test("matches common sensitive field names", () => {
    const sensitiveKeys = [
      "api_key",
      "apiKey",
      "api-key",
      "secret",
      "password",
      "token",
      "credential",
      "auth",
      "AUTH_TOKEN",
    ];
    for (const key of sensitiveKeys) {
      expect(SENSITIVE_PATTERN.test(key)).toBe(true);
    }
  });

  test("does not match safe field names", () => {
    const safeKeys = ["logLevel", "maxTurns", "enabled", "endpoint", "strategy"];
    for (const key of safeKeys) {
      expect(SENSITIVE_PATTERN.test(key)).toBe(false);
    }
  });
});

describe("maskConfig", () => {
  test("redacts top-level sensitive fields", () => {
    const config = { api_key: "sk-abc123", logLevel: "info" };
    const result = maskConfig(config);
    expect(result).toEqual({ api_key: "***", logLevel: "info" });
  });

  test("redacts nested sensitive fields", () => {
    const config = {
      telemetry: { enabled: true, auth_token: "xyz" },
      logLevel: "info",
    };
    const result = maskConfig(config);
    expect(result).toEqual({
      telemetry: { enabled: true, auth_token: "***" },
      logLevel: "info",
    });
  });

  test("does not mutate input", () => {
    const config = { secret: "hunter2", safe: true };
    const original = { ...config };
    maskConfig(config);
    expect(config).toEqual(original);
  });

  test("handles empty object", () => {
    expect(maskConfig({})).toEqual({});
  });

  test("accepts custom pattern", () => {
    const config = { custom_field: "value", other: "kept" };
    const result = maskConfig(config, /custom/i);
    expect(result).toEqual({ custom_field: "***", other: "kept" });
  });

  test("preserves non-object values", () => {
    const config = { items: [1, 2, 3], count: 42, flag: true };
    const result = maskConfig(config);
    expect(result).toEqual({ items: [1, 2, 3], count: 42, flag: true });
  });
});

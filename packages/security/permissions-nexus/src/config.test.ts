import { describe, expect, test } from "bun:test";
import { validateNexusPermissionsConfig } from "./config.js";

describe("validateNexusPermissionsConfig", () => {
  const validConfig = {
    baseUrl: "http://localhost:2026",
    apiKey: "test-key",
  };

  test("accepts valid config", () => {
    const result = validateNexusPermissionsConfig(validConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("http://localhost:2026");
      expect(result.value.apiKey).toBe("test-key");
    }
  });

  test("rejects null", () => {
    const result = validateNexusPermissionsConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects undefined", () => {
    const result = validateNexusPermissionsConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object", () => {
    const result = validateNexusPermissionsConfig("string");
    expect(result.ok).toBe(false);
  });

  test("rejects missing baseUrl", () => {
    const result = validateNexusPermissionsConfig({
      apiKey: "key",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("rejects empty baseUrl", () => {
    const result = validateNexusPermissionsConfig({
      baseUrl: "",
      apiKey: "key",
    });
    expect(result.ok).toBe(false);
  });

  test("rejects missing apiKey", () => {
    const result = validateNexusPermissionsConfig({
      baseUrl: "http://localhost",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects empty apiKey", () => {
    const result = validateNexusPermissionsConfig({
      baseUrl: "http://localhost",
      apiKey: "",
    });
    expect(result.ok).toBe(false);
  });

  test("preserves injectable fetch when provided", () => {
    const fakeFetch = (() => {}) as unknown as typeof globalThis.fetch;
    const result = validateNexusPermissionsConfig({
      ...validConfig,
      fetch: fakeFetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fetch).toBe(fakeFetch);
    }
  });

  test("omits fetch when not provided", () => {
    const result = validateNexusPermissionsConfig(validConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fetch).toBeUndefined();
    }
  });
});

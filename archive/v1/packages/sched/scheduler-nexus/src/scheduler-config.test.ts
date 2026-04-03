/**
 * Tests for validateNexusSchedulerConfig.
 */

import { describe, expect, test } from "bun:test";
import { validateNexusSchedulerConfig } from "./scheduler-config.js";

const VALID_CONFIG = {
  baseUrl: "https://scheduler.nexus.example.com",
  apiKey: "sk-test-123",
} as const;

describe("validateNexusSchedulerConfig", () => {
  test("accepts minimal valid config", () => {
    const result = validateNexusSchedulerConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("https://scheduler.nexus.example.com");
      expect(result.value.apiKey).toBe("sk-test-123");
    }
  });

  test("accepts full config with all optional fields", () => {
    const result = validateNexusSchedulerConfig({
      ...VALID_CONFIG,
      timeoutMs: 5000,
      visibilityTimeoutMs: 60_000,
      fetch: globalThis.fetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timeoutMs).toBe(5000);
      expect(result.value.visibilityTimeoutMs).toBe(60_000);
    }
  });

  test("strips trailing slashes from baseUrl", () => {
    const result = validateNexusSchedulerConfig({
      ...VALID_CONFIG,
      baseUrl: "https://example.com///",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("https://example.com");
    }
  });

  test("rejects null config", () => {
    const result = validateNexusSchedulerConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects undefined config", () => {
    const result = validateNexusSchedulerConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects empty baseUrl", () => {
    const result = validateNexusSchedulerConfig({ ...VALID_CONFIG, baseUrl: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("rejects empty apiKey", () => {
    const result = validateNexusSchedulerConfig({ ...VALID_CONFIG, apiKey: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects negative timeoutMs", () => {
    const result = validateNexusSchedulerConfig({ ...VALID_CONFIG, timeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timeoutMs");
    }
  });

  test("rejects zero timeoutMs", () => {
    const result = validateNexusSchedulerConfig({ ...VALID_CONFIG, timeoutMs: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative visibilityTimeoutMs", () => {
    const result = validateNexusSchedulerConfig({ ...VALID_CONFIG, visibilityTimeoutMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("visibilityTimeoutMs");
    }
  });

  test("rejects zero visibilityTimeoutMs", () => {
    const result = validateNexusSchedulerConfig({ ...VALID_CONFIG, visibilityTimeoutMs: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-function fetch", () => {
    const result = validateNexusSchedulerConfig({ ...VALID_CONFIG, fetch: "not a function" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("fetch");
    }
  });

  test("all validation errors are non-retryable", () => {
    const result = validateNexusSchedulerConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });
});

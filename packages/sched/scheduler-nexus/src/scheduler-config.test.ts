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

  test("accepts full config", () => {
    const result = validateNexusSchedulerConfig({
      ...VALID_CONFIG,
      timeoutMs: 5_000,
      visibilityTimeoutMs: 60_000,
      fetch: globalThis.fetch,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts missing apiKey", () => {
    const result = validateNexusSchedulerConfig({
      baseUrl: "https://scheduler.nexus.example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBeUndefined();
    }
  });

  test("rejects invalid visibilityTimeoutMs", () => {
    const result = validateNexusSchedulerConfig({
      ...VALID_CONFIG,
      visibilityTimeoutMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("visibilityTimeoutMs");
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
});

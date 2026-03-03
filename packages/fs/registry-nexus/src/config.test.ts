/**
 * Tests for NexusRegistryConfig validation.
 */

import { describe, expect, test } from "bun:test";
import type { NexusRegistryConfig } from "./config.js";
import { validateNexusRegistryConfig } from "./config.js";

function validConfig(overrides?: Partial<NexusRegistryConfig>): NexusRegistryConfig {
  return {
    baseUrl: "https://nexus.example.com",
    apiKey: "sk-test-key",
    ...overrides,
  };
}

describe("validateNexusRegistryConfig", () => {
  test("accepts valid config with defaults", () => {
    const result = validateNexusRegistryConfig(validConfig());
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with all options", () => {
    const result = validateNexusRegistryConfig(
      validConfig({
        zoneId: "zone-1",
        timeoutMs: 5000,
        pollIntervalMs: 30_000,
        startupTimeoutMs: 60_000,
        maxEntries: 5000,
      }),
    );
    expect(result.ok).toBe(true);
  });

  test("rejects empty baseUrl", () => {
    const result = validateNexusRegistryConfig(validConfig({ baseUrl: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("rejects empty apiKey", () => {
    const result = validateNexusRegistryConfig(validConfig({ apiKey: "" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects zero timeoutMs", () => {
    const result = validateNexusRegistryConfig(validConfig({ timeoutMs: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("timeoutMs");
    }
  });

  test("rejects negative timeoutMs", () => {
    const result = validateNexusRegistryConfig(validConfig({ timeoutMs: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects negative pollIntervalMs", () => {
    const result = validateNexusRegistryConfig(validConfig({ pollIntervalMs: -1 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("pollIntervalMs");
    }
  });

  test("accepts zero pollIntervalMs (disabled)", () => {
    const result = validateNexusRegistryConfig(validConfig({ pollIntervalMs: 0 }));
    expect(result.ok).toBe(true);
  });

  test("rejects zero maxEntries", () => {
    const result = validateNexusRegistryConfig(validConfig({ maxEntries: 0 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("maxEntries");
    }
  });

  test("rejects negative maxEntries", () => {
    const result = validateNexusRegistryConfig(validConfig({ maxEntries: -10 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

import { describe, expect, test } from "bun:test";
import { DEFAULT_NEXUS_REGISTRY_CONFIG, validateNexusRegistryConfig } from "./config.js";
import { createMockTransport } from "./test-helpers.js";

const dummyTransport = createMockTransport();

describe("validateNexusRegistryConfig", () => {
  test("accepts a minimal config", () => {
    const result = validateNexusRegistryConfig({ transport: dummyTransport });
    expect(result.ok).toBe(true);
  });

  test("rejects negative pollIntervalMs", () => {
    const result = validateNexusRegistryConfig({ transport: dummyTransport, pollIntervalMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("pollIntervalMs");
    }
  });

  test("accepts pollIntervalMs = 0 (disabled)", () => {
    const result = validateNexusRegistryConfig({ transport: dummyTransport, pollIntervalMs: 0 });
    expect(result.ok).toBe(true);
  });

  test("rejects non-positive startupTimeoutMs", () => {
    const result = validateNexusRegistryConfig({ transport: dummyTransport, startupTimeoutMs: 0 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-positive maxEntries", () => {
    const result = validateNexusRegistryConfig({ transport: dummyTransport, maxEntries: 0 });
    expect(result.ok).toBe(false);
  });

  test("DEFAULT_NEXUS_REGISTRY_CONFIG exposes sane defaults", () => {
    expect(DEFAULT_NEXUS_REGISTRY_CONFIG.pollIntervalMs).toBe(10_000);
    expect(DEFAULT_NEXUS_REGISTRY_CONFIG.startupTimeoutMs).toBe(30_000);
    expect(DEFAULT_NEXUS_REGISTRY_CONFIG.maxEntries).toBe(10_000);
  });
});

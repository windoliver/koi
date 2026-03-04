import { describe, expect, test } from "bun:test";
import { validateNexusNameServiceConfig } from "./config.js";

const VALID_CONFIG = {
  baseUrl: "https://nexus.example.com",
  apiKey: "sk-test",
} as const;

describe("validateNexusNameServiceConfig", () => {
  test("accepts minimal valid config", () => {
    const result = validateNexusNameServiceConfig(VALID_CONFIG);
    expect(result.ok).toBe(true);
  });

  test("accepts config with all fields", () => {
    const result = validateNexusNameServiceConfig({
      ...VALID_CONFIG,
      zoneId: "zone-1",
      timeoutMs: 5000,
      pollIntervalMs: 3000,
      maxEntries: 500,
    });
    expect(result.ok).toBe(true);
  });

  test("accepts pollIntervalMs: 0 (disabled)", () => {
    const result = validateNexusNameServiceConfig({
      ...VALID_CONFIG,
      pollIntervalMs: 0,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects empty baseUrl", () => {
    const result = validateNexusNameServiceConfig({ ...VALID_CONFIG, baseUrl: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("rejects empty apiKey", () => {
    const result = validateNexusNameServiceConfig({ ...VALID_CONFIG, apiKey: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects invalid timeoutMs", () => {
    const result = validateNexusNameServiceConfig({ ...VALID_CONFIG, timeoutMs: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timeoutMs");
    }
  });

  test("rejects negative timeoutMs", () => {
    const result = validateNexusNameServiceConfig({ ...VALID_CONFIG, timeoutMs: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects negative pollIntervalMs", () => {
    const result = validateNexusNameServiceConfig({ ...VALID_CONFIG, pollIntervalMs: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("pollIntervalMs");
    }
  });

  test("rejects invalid maxEntries", () => {
    const result = validateNexusNameServiceConfig({ ...VALID_CONFIG, maxEntries: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxEntries");
    }
  });

  test("rejects negative maxEntries", () => {
    const result = validateNexusNameServiceConfig({ ...VALID_CONFIG, maxEntries: -5 });
    expect(result.ok).toBe(false);
  });
});

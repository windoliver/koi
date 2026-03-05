/**
 * Tests for NexusStackConfig boundary validation.
 */

import { describe, expect, test } from "bun:test";
import { validateNexusStackConfig } from "../validate-config.js";

describe("validateNexusStackConfig", () => {
  test("returns ok for valid config", () => {
    const result = validateNexusStackConfig({
      baseUrl: "http://localhost:2026",
      apiKey: "sk-test-key",
    });
    expect(result.ok).toBe(true);
  });

  test("returns error for empty baseUrl", () => {
    const result = validateNexusStackConfig({
      baseUrl: "",
      apiKey: "sk-test-key",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("returns error for whitespace-only baseUrl", () => {
    const result = validateNexusStackConfig({
      baseUrl: "   ",
      apiKey: "sk-test-key",
    });
    expect(result.ok).toBe(false);
  });

  test("returns error for empty apiKey", () => {
    const result = validateNexusStackConfig({
      baseUrl: "http://localhost:2026",
      apiKey: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("returns error for whitespace-only apiKey", () => {
    const result = validateNexusStackConfig({
      baseUrl: "http://localhost:2026",
      apiKey: "  ",
    });
    expect(result.ok).toBe(false);
  });

  test("accepts config with overrides", () => {
    const result = validateNexusStackConfig({
      baseUrl: "http://localhost:2026",
      apiKey: "sk-test-key",
      overrides: { registry: { pollIntervalMs: 5_000 } },
      agentOverrides: { forge: { concurrency: 5 } },
      optIn: { workspace: { basePath: "/ws" } },
    });
    expect(result.ok).toBe(true);
  });

  test("error is not retryable", () => {
    const result = validateNexusStackConfig({ baseUrl: "", apiKey: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.retryable).toBe(false);
    }
  });
});

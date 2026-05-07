import { describe, expect, test } from "bun:test";
import { validateNexusTaskQueueConfig } from "./config.js";

describe("validateNexusTaskQueueConfig", () => {
  test("accepts valid config", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "sk-test-123",
    });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with optional fields", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "sk-test-123",
      timeoutMs: 5_000,
      fetch: globalThis.fetch,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateNexusTaskQueueConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  test("rejects missing baseUrl", () => {
    const result = validateNexusTaskQueueConfig({ apiKey: "sk-test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("accepts missing apiKey", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBeUndefined();
    }
  });

  test("rejects empty apiKey when provided", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects invalid timeoutMs", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "sk-test",
      timeoutMs: 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timeoutMs");
    }
  });

  test("rejects non-function fetch", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "sk-test",
      fetch: "not-a-function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("fetch");
    }
  });

  test("strips trailing slash from baseUrl", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com///",
      apiKey: "sk-test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("https://scheduler.nexus.example.com");
    }
  });
});

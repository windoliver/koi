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
      timeoutMs: 5000,
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

  test("rejects undefined config", () => {
    const result = validateNexusTaskQueueConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects missing baseUrl", () => {
    const result = validateNexusTaskQueueConfig({ apiKey: "sk-test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("rejects empty baseUrl", () => {
    const result = validateNexusTaskQueueConfig({ baseUrl: "", apiKey: "sk-test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("rejects missing apiKey", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects empty apiKey", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects non-number timeoutMs", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "sk-test",
      timeoutMs: "fast",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("timeoutMs");
    }
  });

  test("rejects negative timeoutMs", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "sk-test",
      timeoutMs: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("timeoutMs");
    }
  });

  test("rejects zero timeoutMs", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "sk-test",
      timeoutMs: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects non-function fetch", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com",
      apiKey: "sk-test",
      fetch: "not-a-function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("fetch");
    }
  });

  test("strips trailing slash from baseUrl", () => {
    const result = validateNexusTaskQueueConfig({
      baseUrl: "https://scheduler.nexus.example.com/",
      apiKey: "sk-test",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.baseUrl).toBe("https://scheduler.nexus.example.com");
    }
  });

  test("strips multiple trailing slashes", () => {
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

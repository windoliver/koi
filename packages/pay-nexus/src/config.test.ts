import { describe, expect, test } from "bun:test";
import { validatePayLedgerConfig } from "./config.js";

describe("validatePayLedgerConfig", () => {
  test("accepts valid config", () => {
    const result = validatePayLedgerConfig({
      baseUrl: "https://pay.example.com",
      apiKey: "sk-test-123",
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validatePayLedgerConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("non-null object");
    }
  });

  test("rejects missing baseUrl", () => {
    const result = validatePayLedgerConfig({ apiKey: "sk-test" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("baseUrl");
    }
  });

  test("rejects invalid baseUrl", () => {
    const result = validatePayLedgerConfig({
      baseUrl: "not-a-url",
      apiKey: "sk-test",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("not a valid URL");
    }
  });

  test("rejects missing apiKey", () => {
    const result = validatePayLedgerConfig({
      baseUrl: "https://pay.example.com",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects empty apiKey", () => {
    const result = validatePayLedgerConfig({
      baseUrl: "https://pay.example.com",
      apiKey: "",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("apiKey");
    }
  });

  test("rejects invalid timeout (not a number)", () => {
    const result = validatePayLedgerConfig({
      baseUrl: "https://pay.example.com",
      apiKey: "sk-test",
      timeout: "fast",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("timeout");
    }
  });

  test("rejects invalid timeout (negative)", () => {
    const result = validatePayLedgerConfig({
      baseUrl: "https://pay.example.com",
      apiKey: "sk-test",
      timeout: -1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("timeout");
    }
  });

  test("rejects invalid fetch (not a function)", () => {
    const result = validatePayLedgerConfig({
      baseUrl: "https://pay.example.com",
      apiKey: "sk-test",
      fetch: "not-a-function",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("fetch");
    }
  });

  test("accepts valid config with optional fields", () => {
    const result = validatePayLedgerConfig({
      baseUrl: "https://pay.example.com",
      apiKey: "sk-test-123",
      timeout: 5000,
      fetch: globalThis.fetch,
    });
    expect(result.ok).toBe(true);
  });
});

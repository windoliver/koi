import { describe, expect, test } from "bun:test";
import { validateE2bConfig } from "./validate.js";

describe("validateE2bConfig", () => {
  test("returns ok with valid apiKey", () => {
    const result = validateE2bConfig({ apiKey: "test-key" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("test-key");
    }
  });

  test("falls back to E2B_API_KEY env var", () => {
    const original = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = "env-key";
    try {
      const result = validateE2bConfig({});
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.apiKey).toBe("env-key");
      }
    } finally {
      if (original !== undefined) {
        process.env.E2B_API_KEY = original;
      } else {
        delete process.env.E2B_API_KEY;
      }
    }
  });

  test("returns error when no apiKey provided", () => {
    const original = process.env.E2B_API_KEY;
    delete process.env.E2B_API_KEY;
    try {
      const result = validateE2bConfig({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("E2B API key");
      }
    } finally {
      if (original !== undefined) {
        process.env.E2B_API_KEY = original;
      }
    }
  });

  test("returns error for empty apiKey", () => {
    const result = validateE2bConfig({ apiKey: "" });
    expect(result.ok).toBe(false);
  });

  test("preserves template in validated config", () => {
    const result = validateE2bConfig({ apiKey: "key", template: "my-template" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.template).toBe("my-template");
    }
  });

  test("validates mount paths must be absolute", () => {
    const result = validateE2bConfig({
      apiKey: "key",
      mounts: [{ type: "s3", bucket: "b", mountPath: "relative", credentials: {} }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("absolute");
    }
  });

  test("accepts valid mount paths", () => {
    const result = validateE2bConfig({
      apiKey: "key",
      mounts: [{ type: "s3", bucket: "b", mountPath: "/mnt/data", credentials: {} }],
    });
    expect(result.ok).toBe(true);
  });
});

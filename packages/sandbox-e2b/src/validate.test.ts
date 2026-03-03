import { describe, expect, mock, test } from "bun:test";
import type { E2bClient } from "./types.js";
import { validateE2bConfig } from "./validate.js";

const mockClient: E2bClient = {
  createSandbox: mock(() => Promise.resolve({} as Awaited<ReturnType<E2bClient["createSandbox"]>>)),
};

describe("validateE2bConfig", () => {
  test("returns error when client not provided", () => {
    const result = validateE2bConfig({ apiKey: "key" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("client");
    }
  });

  test("returns ok with valid apiKey and client", () => {
    const result = validateE2bConfig({ apiKey: "test-key", client: mockClient });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("test-key");
    }
  });

  test("falls back to E2B_API_KEY env var", () => {
    const original = process.env.E2B_API_KEY;
    process.env.E2B_API_KEY = "env-key";
    try {
      const result = validateE2bConfig({ client: mockClient });
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
      const result = validateE2bConfig({ client: mockClient });
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
    const result = validateE2bConfig({ apiKey: "", client: mockClient });
    expect(result.ok).toBe(false);
  });

  test("preserves template in validated config", () => {
    const result = validateE2bConfig({
      apiKey: "key",
      template: "my-template",
      client: mockClient,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.template).toBe("my-template");
    }
  });

  test("validates mount paths must be absolute", () => {
    const result = validateE2bConfig({
      apiKey: "key",
      client: mockClient,
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
      client: mockClient,
      mounts: [{ type: "s3", bucket: "b", mountPath: "/mnt/data", credentials: {} }],
    });
    expect(result.ok).toBe(true);
  });
});

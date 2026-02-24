import { describe, expect, test } from "bun:test";
import { validateDaytonaConfig } from "./validate.js";

describe("validateDaytonaConfig", () => {
  test("returns ok with valid apiKey", () => {
    const result = validateDaytonaConfig({ apiKey: "test-key" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.apiKey).toBe("test-key");
      expect(result.value.target).toBe("us");
    }
  });

  test("falls back to DAYTONA_API_KEY env var", () => {
    const original = process.env.DAYTONA_API_KEY;
    process.env.DAYTONA_API_KEY = "env-key";
    try {
      const result = validateDaytonaConfig({});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.apiKey).toBe("env-key");
    } finally {
      if (original !== undefined) process.env.DAYTONA_API_KEY = original;
      else delete process.env.DAYTONA_API_KEY;
    }
  });

  test("returns error when no apiKey provided", () => {
    const original = process.env.DAYTONA_API_KEY;
    delete process.env.DAYTONA_API_KEY;
    try {
      const result = validateDaytonaConfig({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    } finally {
      if (original !== undefined) process.env.DAYTONA_API_KEY = original;
    }
  });

  test("uses custom apiUrl", () => {
    const result = validateDaytonaConfig({
      apiKey: "key",
      apiUrl: "https://custom.daytona.io/api",
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.apiUrl).toBe("https://custom.daytona.io/api");
  });

  test("falls back to DAYTONA_API_URL env var", () => {
    const original = process.env.DAYTONA_API_URL;
    process.env.DAYTONA_API_URL = "https://env.daytona.io/api";
    try {
      const result = validateDaytonaConfig({ apiKey: "key" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.apiUrl).toBe("https://env.daytona.io/api");
    } finally {
      if (original !== undefined) process.env.DAYTONA_API_URL = original;
      else delete process.env.DAYTONA_API_URL;
    }
  });

  test("uses default apiUrl when not set", () => {
    const originalUrl = process.env.DAYTONA_API_URL;
    delete process.env.DAYTONA_API_URL;
    try {
      const result = validateDaytonaConfig({ apiKey: "key" });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.apiUrl).toBe("https://app.daytona.io/api");
    } finally {
      if (originalUrl !== undefined) process.env.DAYTONA_API_URL = originalUrl;
    }
  });

  test("uses custom target", () => {
    const result = validateDaytonaConfig({ apiKey: "key", target: "eu" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.target).toBe("eu");
  });

  test("validates volume mount paths must be absolute", () => {
    const result = validateDaytonaConfig({
      apiKey: "key",
      volumes: [{ volumeId: "vol-1", mountPath: "relative" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("absolute");
  });

  test("accepts valid volume mount paths", () => {
    const result = validateDaytonaConfig({
      apiKey: "key",
      volumes: [{ volumeId: "vol-1", mountPath: "/mnt/data" }],
    });
    expect(result.ok).toBe(true);
  });
});

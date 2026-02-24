import { describe, expect, test } from "bun:test";
import { validateCloudflareConfig } from "./validate.js";

describe("validateCloudflareConfig", () => {
  test("returns ok with valid apiToken", () => {
    const result = validateCloudflareConfig({ apiToken: "test-token" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.apiToken).toBe("test-token");
  });

  test("falls back to CLOUDFLARE_API_TOKEN env var", () => {
    const original = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "env-token";
    try {
      const result = validateCloudflareConfig({});
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.value.apiToken).toBe("env-token");
    } finally {
      if (original !== undefined) process.env.CLOUDFLARE_API_TOKEN = original;
      else delete process.env.CLOUDFLARE_API_TOKEN;
    }
  });

  test("returns error when no apiToken provided", () => {
    const original = process.env.CLOUDFLARE_API_TOKEN;
    delete process.env.CLOUDFLARE_API_TOKEN;
    try {
      const result = validateCloudflareConfig({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    } finally {
      if (original !== undefined) process.env.CLOUDFLARE_API_TOKEN = original;
    }
  });

  test("validates R2 mount paths must be absolute", () => {
    const result = validateCloudflareConfig({
      apiToken: "key",
      r2Mounts: [{ bucketName: "bucket", mountPath: "relative" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("absolute");
  });

  test("accepts valid R2 mount paths", () => {
    const result = validateCloudflareConfig({
      apiToken: "key",
      r2Mounts: [{ bucketName: "bucket", mountPath: "/mnt/r2" }],
    });
    expect(result.ok).toBe(true);
  });

  test("preserves accountId", () => {
    const result = validateCloudflareConfig({ apiToken: "key", accountId: "acc-123" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.accountId).toBe("acc-123");
  });
});

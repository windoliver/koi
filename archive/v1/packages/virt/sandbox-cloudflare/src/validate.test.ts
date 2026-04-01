import { describe, expect, mock, test } from "bun:test";
import type { CloudflareClient } from "./types.js";
import { validateCloudflareConfig } from "./validate.js";

const mockClient: CloudflareClient = {
  createSandbox: mock(() =>
    Promise.resolve({} as Awaited<ReturnType<CloudflareClient["createSandbox"]>>),
  ),
};

describe("validateCloudflareConfig", () => {
  test("returns error when client not provided", () => {
    const result = validateCloudflareConfig({ apiToken: "key" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("client");
    }
  });

  test("returns ok with valid apiToken and client", () => {
    const result = validateCloudflareConfig({ apiToken: "test-token", client: mockClient });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.apiToken).toBe("test-token");
  });

  test("falls back to CLOUDFLARE_API_TOKEN env var", () => {
    const original = process.env.CLOUDFLARE_API_TOKEN;
    process.env.CLOUDFLARE_API_TOKEN = "env-token";
    try {
      const result = validateCloudflareConfig({ client: mockClient });
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
      const result = validateCloudflareConfig({ client: mockClient });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe("VALIDATION");
    } finally {
      if (original !== undefined) process.env.CLOUDFLARE_API_TOKEN = original;
    }
  });

  test("validates R2 mount paths must be absolute", () => {
    const result = validateCloudflareConfig({
      apiToken: "key",
      client: mockClient,
      r2Mounts: [{ bucketName: "bucket", mountPath: "relative" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("absolute");
  });

  test("accepts valid R2 mount paths", () => {
    const result = validateCloudflareConfig({
      apiToken: "key",
      client: mockClient,
      r2Mounts: [{ bucketName: "bucket", mountPath: "/mnt/r2" }],
    });
    expect(result.ok).toBe(true);
  });

  test("preserves accountId", () => {
    const result = validateCloudflareConfig({
      apiToken: "key",
      accountId: "acc-123",
      client: mockClient,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.accountId).toBe("acc-123");
  });
});

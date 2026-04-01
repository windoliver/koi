import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  resolveServerConfig,
  validateServerConfig,
  validateServerConfigs,
} from "./config.js";

// ---------------------------------------------------------------------------
// validateServerConfig — single server
// ---------------------------------------------------------------------------

describe("validateServerConfig", () => {
  test("accepts valid stdio config", () => {
    const result = validateServerConfig({
      name: "fs-server",
      transport: { transport: "stdio", command: "npx", args: ["-y", "@mcp/fs"] },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.name).toBe("fs-server");
      expect(result.value.transport.transport).toBe("stdio");
    }
  });

  test("accepts valid http config", () => {
    const result = validateServerConfig({
      name: "remote",
      transport: { transport: "http", url: "https://mcp.example.com/v1" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.transport.transport).toBe("http");
    }
  });

  test("accepts valid sse config", () => {
    const result = validateServerConfig({
      name: "legacy",
      transport: { transport: "sse", url: "https://legacy.example.com/sse" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.transport.transport).toBe("sse");
    }
  });

  test("accepts optional fields: timeoutMs, connectTimeoutMs, maxReconnectAttempts", () => {
    const result = validateServerConfig({
      name: "custom",
      transport: { transport: "stdio", command: "node" },
      timeoutMs: 60_000,
      connectTimeoutMs: 5_000,
      maxReconnectAttempts: 5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.timeoutMs).toBe(60_000);
      expect(result.value.connectTimeoutMs).toBe(5_000);
      expect(result.value.maxReconnectAttempts).toBe(5);
    }
  });

  test("accepts http config with headers", () => {
    const result = validateServerConfig({
      name: "authed",
      transport: {
        transport: "http",
        url: "https://mcp.example.com/v1",
        headers: { Authorization: "Bearer tok123" },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts stdio config with env", () => {
    const result = validateServerConfig({
      name: "env-server",
      transport: {
        transport: "stdio",
        command: "my-server",
        env: { NODE_ENV: "production" },
      },
    });
    expect(result.ok).toBe(true);
  });

  // --- Validation errors ---

  test("rejects empty name", () => {
    const result = validateServerConfig({
      name: "",
      transport: { transport: "stdio", command: "npx" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects missing name", () => {
    const result = validateServerConfig({
      transport: { transport: "stdio", command: "npx" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects unknown transport type", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "grpc", url: "grpc://localhost" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects stdio without command", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "stdio" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects stdio with empty command", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "stdio", command: "" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects http without url", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "http" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects http with invalid url", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "http", url: "not-a-url" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects sse without url", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "sse" },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative timeoutMs", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "stdio", command: "npx" },
      timeoutMs: -1,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects zero timeoutMs", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "stdio", command: "npx" },
      timeoutMs: 0,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects negative maxReconnectAttempts", () => {
    const result = validateServerConfig({
      name: "bad",
      transport: { transport: "stdio", command: "npx" },
      maxReconnectAttempts: -1,
    });
    expect(result.ok).toBe(false);
  });

  test("accepts zero maxReconnectAttempts (no retries)", () => {
    const result = validateServerConfig({
      name: "no-retry",
      transport: { transport: "stdio", command: "npx" },
      maxReconnectAttempts: 0,
    });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// validateServerConfigs — array
// ---------------------------------------------------------------------------

describe("validateServerConfigs", () => {
  test("accepts array of valid configs", () => {
    const result = validateServerConfigs([
      { name: "a", transport: { transport: "stdio", command: "npx" } },
      { name: "b", transport: { transport: "http", url: "https://example.com" } },
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
    }
  });

  test("rejects empty array", () => {
    const result = validateServerConfigs([]);
    expect(result.ok).toBe(false);
  });

  test("rejects non-array", () => {
    const result = validateServerConfigs("not-an-array");
    expect(result.ok).toBe(false);
  });

  test("rejects if any server is invalid", () => {
    const result = validateServerConfigs([
      { name: "good", transport: { transport: "stdio", command: "npx" } },
      { name: "", transport: { transport: "stdio", command: "npx" } },
    ]);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveServerConfig — defaults
// ---------------------------------------------------------------------------

describe("resolveServerConfig", () => {
  test("applies default timeoutMs", () => {
    const resolved = resolveServerConfig({
      name: "test",
      transport: { transport: "stdio", command: "npx" },
    });
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  test("applies default connectTimeoutMs", () => {
    const resolved = resolveServerConfig({
      name: "test",
      transport: { transport: "stdio", command: "npx" },
    });
    expect(resolved.connectTimeoutMs).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
  });

  test("applies default maxReconnectAttempts", () => {
    const resolved = resolveServerConfig({
      name: "test",
      transport: { transport: "stdio", command: "npx" },
    });
    expect(resolved.maxReconnectAttempts).toBe(DEFAULT_MAX_RECONNECT_ATTEMPTS);
  });

  test("preserves explicit values", () => {
    const resolved = resolveServerConfig({
      name: "test",
      transport: { transport: "http", url: "https://example.com" },
      timeoutMs: 5_000,
      connectTimeoutMs: 2_000,
      maxReconnectAttempts: 10,
    });
    expect(resolved.timeoutMs).toBe(5_000);
    expect(resolved.connectTimeoutMs).toBe(2_000);
    expect(resolved.maxReconnectAttempts).toBe(10);
  });

  test("passes through transport config unchanged", () => {
    const transport = {
      transport: "http" as const,
      url: "https://example.com",
      headers: { "X-Custom": "value" },
    };
    const resolved = resolveServerConfig({ name: "test", transport });
    expect(resolved.transport).toEqual(transport);
  });
});

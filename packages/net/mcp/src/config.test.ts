import { describe, expect, test } from "bun:test";
import type { McpProviderConfig, McpServerConfig } from "./config.js";
import {
  resolveProviderConfig,
  resolveServerConfig,
  validateMcpProviderConfig,
  validateMcpServerConfig,
} from "./config.js";

// ---------------------------------------------------------------------------
// validateMcpServerConfig
// ---------------------------------------------------------------------------

describe("validateMcpServerConfig", () => {
  test("validates a valid stdio server config", () => {
    const config = validateMcpServerConfig({
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["@anthropic/mcp-server-filesystem", "/workspace"],
    });
    expect(config.name).toBe("filesystem");
    expect(config.transport).toBe("stdio");
    expect(config.command).toBe("npx");
  });

  test("validates a valid http server config", () => {
    const config = validateMcpServerConfig({
      name: "api-server",
      transport: "http",
      url: "https://example.com/mcp",
    });
    expect(config.name).toBe("api-server");
    expect(config.transport).toBe("http");
    expect(config.url).toBe("https://example.com/mcp");
  });

  test("validates a valid sse server config", () => {
    const config = validateMcpServerConfig({
      name: "sse-server",
      transport: "sse",
      url: "https://example.com/sse",
      headers: { Authorization: "Bearer token" },
    });
    expect(config.name).toBe("sse-server");
    expect(config.transport).toBe("sse");
  });

  test("rejects missing name", () => {
    expect(() => validateMcpServerConfig({ transport: "stdio", command: "npx" })).toThrow();
  });

  test("rejects empty name", () => {
    expect(() =>
      validateMcpServerConfig({ name: "", transport: "stdio", command: "npx" }),
    ).toThrow();
  });

  test("rejects unknown transport type", () => {
    expect(() => validateMcpServerConfig({ name: "x", transport: "grpc" })).toThrow();
  });

  test("accepts optional mode and timeoutMs", () => {
    const config = validateMcpServerConfig({
      name: "test",
      transport: "stdio",
      command: "npx",
      mode: "discover",
      timeoutMs: 5000,
    });
    expect(config.mode).toBe("discover");
    expect(config.timeoutMs).toBe(5000);
  });

  test("rejects invalid timeoutMs", () => {
    expect(() =>
      validateMcpServerConfig({
        name: "test",
        transport: "stdio",
        command: "npx",
        timeoutMs: -1,
      }),
    ).toThrow();
  });

  test("rejects invalid url for http transport", () => {
    expect(() =>
      validateMcpServerConfig({
        name: "test",
        transport: "http",
        url: "not-a-url",
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateMcpProviderConfig
// ---------------------------------------------------------------------------

describe("validateMcpProviderConfig", () => {
  test("validates a valid provider config", () => {
    const config = validateMcpProviderConfig({
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
    });
    expect(config.servers).toHaveLength(1);
  });

  test("rejects empty servers array", () => {
    expect(() => validateMcpProviderConfig({ servers: [] })).toThrow();
  });

  test("accepts optional connectTimeoutMs and maxReconnectAttempts", () => {
    const config = validateMcpProviderConfig({
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
      connectTimeoutMs: 5000,
      maxReconnectAttempts: 5,
    });
    expect(config.connectTimeoutMs).toBe(5000);
    expect(config.maxReconnectAttempts).toBe(5);
  });

  test("rejects negative maxReconnectAttempts", () => {
    expect(() =>
      validateMcpProviderConfig({
        servers: [{ name: "fs", transport: "stdio", command: "npx" }],
        maxReconnectAttempts: -1,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveServerConfig
// ---------------------------------------------------------------------------

describe("resolveServerConfig", () => {
  test("applies default mode and timeout for stdio", () => {
    const server: McpServerConfig = {
      name: "fs",
      transport: "stdio",
      command: "npx",
      args: ["server"],
    };
    const resolved = resolveServerConfig(server);
    expect(resolved.name).toBe("fs");
    expect(resolved.mode).toBe("tools");
    expect(resolved.timeoutMs).toBe(30_000);
    expect(resolved.transport).toEqual({
      transport: "stdio",
      command: "npx",
      args: ["server"],
      env: undefined,
    });
  });

  test("preserves explicit mode and timeout", () => {
    const server: McpServerConfig = {
      name: "search",
      transport: "http",
      url: "https://example.com/mcp",
      mode: "discover",
      timeoutMs: 5000,
    };
    const resolved = resolveServerConfig(server);
    expect(resolved.mode).toBe("discover");
    expect(resolved.timeoutMs).toBe(5000);
    expect(resolved.transport).toEqual({
      transport: "http",
      url: "https://example.com/mcp",
      headers: undefined,
    });
  });

  test("throws for stdio without command", () => {
    const server: McpServerConfig = {
      name: "bad",
      transport: "stdio",
    };
    expect(() => resolveServerConfig(server)).toThrow();
  });

  test("throws for http without url", () => {
    const server: McpServerConfig = {
      name: "bad",
      transport: "http",
    };
    expect(() => resolveServerConfig(server)).toThrow();
  });

  test("throws for sse without url", () => {
    const server: McpServerConfig = {
      name: "bad",
      transport: "sse",
    };
    expect(() => resolveServerConfig(server)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveProviderConfig
// ---------------------------------------------------------------------------

describe("resolveProviderConfig", () => {
  test("applies defaults for provider config", () => {
    const config: McpProviderConfig = {
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
    };
    const resolved = resolveProviderConfig(config);
    expect(resolved.connectTimeoutMs).toBe(10_000);
    expect(resolved.maxReconnectAttempts).toBe(3);
    expect(resolved.servers).toHaveLength(1);
  });

  test("preserves explicit provider values", () => {
    const config: McpProviderConfig = {
      servers: [{ name: "fs", transport: "stdio", command: "npx" }],
      connectTimeoutMs: 5000,
      maxReconnectAttempts: 5,
    };
    const resolved = resolveProviderConfig(config);
    expect(resolved.connectTimeoutMs).toBe(5000);
    expect(resolved.maxReconnectAttempts).toBe(5);
  });
});

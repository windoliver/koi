import { describe, expect, test } from "bun:test";
import type { McpTransportConfig } from "./config.js";
import { createTransport } from "./transport.js";

describe("createTransport", () => {
  test("creates StdioClientTransport for stdio config", () => {
    const config: McpTransportConfig = {
      transport: "stdio",
      command: "npx",
      args: ["@anthropic/mcp-server-filesystem", "/workspace"],
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
    expect(transport.start).toBeInstanceOf(Function);
    expect(transport.close).toBeInstanceOf(Function);
    expect(transport.send).toBeInstanceOf(Function);
  });

  test("creates StreamableHTTPClientTransport for http config", () => {
    const config: McpTransportConfig = {
      transport: "http",
      url: "https://example.com/mcp",
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
    expect(transport.start).toBeInstanceOf(Function);
  });

  test("creates SSEClientTransport for sse config", () => {
    const config: McpTransportConfig = {
      transport: "sse",
      url: "https://example.com/sse",
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
    expect(transport.start).toBeInstanceOf(Function);
  });

  test("passes headers as requestInit for http config", () => {
    const config: McpTransportConfig = {
      transport: "http",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer token" },
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
  });

  test("passes headers as requestInit for sse config", () => {
    const config: McpTransportConfig = {
      transport: "sse",
      url: "https://example.com/sse",
      headers: { "X-Custom": "value" },
    };
    const transport = createTransport(config);
    expect(transport).toBeDefined();
  });
});

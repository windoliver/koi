import { describe, expect, test } from "bun:test";
import { loadMcpJsonString } from "./mcp-json.js";

describe("loadMcpJsonString", () => {
  test("parses CC-format .mcp.json", () => {
    const result = loadMcpJsonString(
      JSON.stringify({
        mcpServers: {
          sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
          "my-local": { command: "npx", args: ["my-server"] },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servers).toHaveLength(2);
      const http = result.value.servers.find((s) => s.name === "sentry");
      expect(http?.kind).toBe("http");
      const stdio = result.value.servers.find((s) => s.name === "my-local");
      expect(stdio?.kind).toBe("stdio");
    }
  });

  test("filters unsupported transport types", () => {
    const result = loadMcpJsonString(
      JSON.stringify({
        mcpServers: {
          good: { type: "http", url: "https://example.com" },
          ws: { type: "ws", url: "wss://example.com" },
          sdk: { type: "sdk", name: "vscode" },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servers).toHaveLength(1);
      expect(result.value.unsupported).toEqual(["ws (ws)", "sdk (sdk)"]);
    }
  });

  test("handles empty mcpServers", () => {
    const result = loadMcpJsonString(JSON.stringify({ mcpServers: {} }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servers).toHaveLength(0);
    }
  });

  test("returns error for invalid JSON", () => {
    const result = loadMcpJsonString("not json {{{");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("returns error for missing mcpServers key", () => {
    const result = loadMcpJsonString(JSON.stringify({ servers: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("preserves headers through normalization", () => {
    const result = loadMcpJsonString(
      JSON.stringify({
        mcpServers: {
          authed: {
            type: "http",
            url: "https://example.com",
            headers: { "X-Custom": "value" },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const server = result.value.servers[0];
      if (server?.kind === "http") {
        expect(server.headers?.["X-Custom"]).toBe("value");
      }
    }
  });

  test("real-world CC config from docs", () => {
    const result = loadMcpJsonString(
      JSON.stringify({
        mcpServers: {
          sentry: {
            type: "http",
            url: "https://mcp.sentry.dev/mcp",
          },
          "my-local-server": {
            command: "npx",
            args: ["my-mcp-server"],
            env: { API_KEY: "test-key" },
          },
          corridor: {
            type: "http",
            url: "https://app.corridor.dev/api/mcp",
            headers: { Authorization: "Bearer tok123" },
          },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servers).toHaveLength(3);
      expect(result.value.unsupported).toHaveLength(0);
    }
  });
});

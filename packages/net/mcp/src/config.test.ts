import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_MAX_RECONNECT_ATTEMPTS,
  DEFAULT_TIMEOUT_MS,
  normalizeMcpServers,
  resolveServerConfig,
  validateMcpJson,
} from "./config.js";

// ---------------------------------------------------------------------------
// validateMcpJson — CC-compatible external schema
// ---------------------------------------------------------------------------

describe("validateMcpJson", () => {
  test("accepts stdio server (type omitted)", () => {
    const result = validateMcpJson({
      mcpServers: {
        "fs-server": { command: "npx", args: ["-y", "@mcp/fs"] },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts stdio server (type explicit)", () => {
    const result = validateMcpJson({
      mcpServers: {
        "fs-server": { type: "stdio", command: "npx" },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts http server", () => {
    const result = validateMcpJson({
      mcpServers: {
        remote: { type: "http", url: "https://mcp.example.com/v1" },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts sse server", () => {
    const result = validateMcpJson({
      mcpServers: {
        legacy: { type: "sse", url: "https://sse.example.com" },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts http with headers", () => {
    const result = validateMcpJson({
      mcpServers: {
        authed: {
          type: "http",
          url: "https://example.com",
          headers: { Authorization: "Bearer tok" },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts http with headersHelper", () => {
    const result = validateMcpJson({
      mcpServers: {
        dynamic: {
          type: "http",
          url: "https://example.com",
          headersHelper: "/path/to/helper.sh",
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts http with oauth config", () => {
    const result = validateMcpJson({
      mcpServers: {
        oauth: {
          type: "http",
          url: "https://example.com",
          oauth: { clientId: "my-client", callbackPort: 8080 },
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts ws server (CC compat)", () => {
    const result = validateMcpJson({
      mcpServers: {
        "ws-server": { type: "ws", url: "wss://example.com" },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts sdk server (CC compat)", () => {
    const result = validateMcpJson({
      mcpServers: {
        "sdk-server": { type: "sdk", name: "claude-vscode" },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts multiple servers", () => {
    const result = validateMcpJson({
      mcpServers: {
        a: { command: "server-a" },
        b: { type: "http", url: "https://b.example.com" },
      },
    });
    expect(result.ok).toBe(true);
  });

  test("accepts stdio with env vars", () => {
    const result = validateMcpJson({
      mcpServers: {
        envd: { command: "npx", env: { API_KEY: "${MCP_KEY}" } },
      },
    });
    expect(result.ok).toBe(true);
  });

  // --- Validation errors ---

  test("rejects missing mcpServers key", () => {
    const result = validateMcpJson({ servers: {} });
    expect(result.ok).toBe(false);
  });

  test("rejects stdio with empty command", () => {
    const result = validateMcpJson({
      mcpServers: { bad: { command: "" } },
    });
    expect(result.ok).toBe(false);
  });

  test("rejects unknown type", () => {
    const result = validateMcpJson({
      mcpServers: { bad: { type: "grpc", url: "grpc://localhost" } },
    });
    expect(result.ok).toBe(false);
  });

  test("accepts empty mcpServers (no servers)", () => {
    const result = validateMcpJson({ mcpServers: {} });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// normalizeMcpServers — CC external → Koi internal
// ---------------------------------------------------------------------------

describe("normalizeMcpServers", () => {
  test("normalizes stdio server", () => {
    const { servers, unsupported, rejected } = normalizeMcpServers({
      "my-server": { command: "npx", args: ["-y", "server"] },
    });
    expect(servers).toHaveLength(1);
    expect(unsupported).toHaveLength(0);
    expect(rejected).toHaveLength(0);
    expect(servers[0]?.kind).toBe("stdio");
    expect(servers[0]?.name).toBe("my-server");
    if (servers[0]?.kind === "stdio") {
      expect(servers[0].command).toBe("npx");
      expect(servers[0].args).toEqual(["-y", "server"]);
    }
  });

  test("normalizes http server", () => {
    const { servers } = normalizeMcpServers({
      remote: { type: "http", url: "https://example.com" },
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.kind).toBe("http");
    if (servers[0]?.kind === "http") {
      expect(servers[0].url).toBe("https://example.com");
    }
  });

  test("normalizes sse server", () => {
    const { servers } = normalizeMcpServers({
      legacy: { type: "sse", url: "https://sse.example.com" },
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.kind).toBe("sse");
  });

  test("filters unsupported ws type", () => {
    const { servers, unsupported } = normalizeMcpServers({
      good: { type: "http", url: "https://example.com" },
      bad: { type: "ws", url: "wss://example.com" },
    });
    expect(servers).toHaveLength(1);
    expect(unsupported).toEqual(["bad (ws)"]);
  });

  test("filters unsupported sdk type", () => {
    const { unsupported } = normalizeMcpServers({
      ide: { type: "sdk", name: "vscode" },
    });
    expect(unsupported).toEqual(["ide (sdk)"]);
  });

  test("filters unsupported sse-ide type", () => {
    const { unsupported } = normalizeMcpServers({
      ide: { type: "sse-ide", url: "http://localhost", ideName: "vscode" },
    });
    expect(unsupported).toEqual(["ide (sse-ide)"]);
  });

  test("expands env vars in stdio command", () => {
    process.env.TEST_MCP_CMD = "my-server";
    try {
      const { servers } = normalizeMcpServers({
        s: { command: "${TEST_MCP_CMD}" },
      });
      expect(servers[0]?.kind).toBe("stdio");
      if (servers[0]?.kind === "stdio") {
        expect(servers[0].command).toBe("my-server");
      }
    } finally {
      delete process.env.TEST_MCP_CMD;
    }
  });

  test("expands env vars in http url", () => {
    process.env.TEST_MCP_URL = "https://expanded.example.com";
    try {
      const { servers } = normalizeMcpServers({
        s: { type: "http", url: "${TEST_MCP_URL}" },
      });
      if (servers[0]?.kind === "http") {
        expect(servers[0].url).toBe("https://expanded.example.com");
      }
    } finally {
      delete process.env.TEST_MCP_URL;
    }
  });

  test("expands env vars in headers", () => {
    process.env.TEST_MCP_TOKEN = "secret123";
    try {
      const { servers } = normalizeMcpServers({
        s: {
          type: "http",
          url: "https://example.com",
          headers: { Authorization: "Bearer ${TEST_MCP_TOKEN}" },
        },
      });
      if (servers[0]?.kind === "http") {
        expect(servers[0].headers?.Authorization).toBe("Bearer secret123");
      }
    } finally {
      delete process.env.TEST_MCP_TOKEN;
    }
  });

  test("expands env vars with default value syntax", () => {
    delete process.env.TEST_MCP_MISSING;
    const { servers } = normalizeMcpServers({
      s: { type: "http", url: "https://${TEST_MCP_MISSING:-fallback.example.com}" },
    });
    if (servers[0]?.kind === "http") {
      expect(servers[0].url).toBe("https://fallback.example.com");
    }
  });

  test("omits empty args array", () => {
    const { servers } = normalizeMcpServers({
      s: { command: "npx" },
    });
    if (servers[0]?.kind === "stdio") {
      expect(servers[0].args).toBeUndefined();
    }
  });

  test("preserves name from record key", () => {
    const { servers } = normalizeMcpServers({
      "my-special-server": { command: "npx" },
    });
    expect(servers[0]?.name).toBe("my-special-server");
  });

  test("rejects config with headersHelper (not yet implemented)", () => {
    const { servers, rejected } = normalizeMcpServers({
      authed: {
        type: "http",
        url: "https://example.com",
        headersHelper: "/path/to/helper.sh",
      },
    });
    expect(servers).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("headersHelper");
  });

  test("rejects config with oauth (not yet implemented)", () => {
    const { servers, rejected } = normalizeMcpServers({
      "oauth-server": {
        type: "http",
        url: "https://example.com",
        oauth: { clientId: "my-client" },
      },
    });
    expect(servers).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("oauth");
  });

  test("allows supported servers alongside rejected auth servers", () => {
    const { servers, rejected } = normalizeMcpServers({
      good: { type: "http", url: "https://example.com" },
      "needs-oauth": { type: "http", url: "https://authed.com", oauth: { clientId: "x" } },
    });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe("good");
    expect(rejected).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// resolveServerConfig — defaults
// ---------------------------------------------------------------------------

describe("resolveServerConfig", () => {
  test("applies default timeoutMs", () => {
    const resolved = resolveServerConfig({
      kind: "stdio",
      name: "test",
      command: "npx",
    });
    expect(resolved.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  test("applies default connectTimeoutMs", () => {
    const resolved = resolveServerConfig({
      kind: "stdio",
      name: "test",
      command: "npx",
    });
    expect(resolved.connectTimeoutMs).toBe(DEFAULT_CONNECT_TIMEOUT_MS);
  });

  test("applies default maxReconnectAttempts", () => {
    const resolved = resolveServerConfig({
      kind: "stdio",
      name: "test",
      command: "npx",
    });
    expect(resolved.maxReconnectAttempts).toBe(DEFAULT_MAX_RECONNECT_ATTEMPTS);
  });

  test("preserves explicit values", () => {
    const resolved = resolveServerConfig(
      { kind: "http", name: "test", url: "https://example.com" },
      { timeoutMs: 5_000, connectTimeoutMs: 2_000, maxReconnectAttempts: 10 },
    );
    expect(resolved.timeoutMs).toBe(5_000);
    expect(resolved.connectTimeoutMs).toBe(2_000);
    expect(resolved.maxReconnectAttempts).toBe(10);
  });

  test("stores server config in .server field", () => {
    const server = { kind: "http" as const, name: "test", url: "https://example.com" };
    const resolved = resolveServerConfig(server);
    expect(resolved.server).toEqual(server);
  });
});

/**
 * End-to-end tests using real MCP SDK server + client.
 *
 * No mocks — exercises the actual MCP protocol via InMemoryTransport,
 * validates the full pipeline: .mcp.json → config → connection → tools.
 */

import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { resolveServerConfig } from "../config.js";
import { createMcpConnection } from "../connection.js";
import { loadMcpJsonString, normalizeMcpServers } from "../index.js";

// ---------------------------------------------------------------------------
// Test MCP server
// ---------------------------------------------------------------------------

function createTestMcpServer(): Server {
  const server = new Server(
    { name: "e2e-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "echo",
        description: "Echoes the input",
        inputSchema: {
          type: "object" as const,
          properties: { message: { type: "string" } },
          required: ["message"],
        },
      },
      {
        name: "add",
        description: "Adds two numbers",
        inputSchema: {
          type: "object" as const,
          properties: { a: { type: "number" }, b: { type: "number" } },
          required: ["a", "b"],
        },
      },
      {
        name: "fail",
        description: "Always fails",
        inputSchema: { type: "object" as const },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    switch (name) {
      case "echo":
        return { content: [{ type: "text" as const, text: String(args.message) }] };
      case "add":
        return {
          content: [{ type: "text" as const, text: String(Number(args.a) + Number(args.b)) }],
        };
      case "fail":
        return {
          content: [{ type: "text" as const, text: "Something went wrong" }],
          isError: true,
        };
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  });

  return server;
}

/**
 * Creates DI deps that wire McpConnection to a real MCP server via InMemoryTransport.
 * Each call to createClient returns a fresh, unconnected SDK Client.
 * The transport's sdkTransport is the client-side of an InMemoryTransport linked to the server.
 */
/**
 * Creates a fresh MCP server + DI deps per call.
 * Each invocation returns an isolated server/transport pair.
 */
function createE2eFixture() {
  const server = createTestMcpServer();

  const deps = {
    createClient: () => new Client({ name: "e2e-client", version: "1.0.0" }) as never,
    createTransport: () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      void server.connect(serverSide);
      return {
        start: async () => {},
        close: async () => {
          await clientSide.close();
        },
        sdkTransport: clientSide,
        get sessionId() {
          return undefined;
        },
        onEvent: () => () => {},
      };
    },
  };

  const cleanup = async (): Promise<void> => {
    try {
      await server.close();
    } catch {
      // best-effort
    }
  };

  return { server, deps, cleanup };
}

// ---------------------------------------------------------------------------
// E2E: Raw MCP protocol
// ---------------------------------------------------------------------------

describe("E2E: raw MCP protocol via InMemoryTransport", () => {
  test("list tools returns all server tools", async () => {
    const server = createTestMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.listTools();
    expect(result.tools).toHaveLength(3);
    expect(result.tools.map((t) => t.name).sort()).toEqual(["add", "echo", "fail"]);

    await client.close();
    await server.close();
  });

  test("call echo tool returns input", async () => {
    const server = createTestMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "echo", arguments: { message: "Hello!" } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("Hello!");

    await client.close();
    await server.close();
  });

  test("call add tool computes sum", async () => {
    const server = createTestMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "add", arguments: { a: 3, b: 7 } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toBe("10");

    await client.close();
    await server.close();
  });

  test("call fail tool returns isError", async () => {
    const server = createTestMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    await client.connect(clientTransport);

    const result = await client.callTool({ name: "fail", arguments: {} });
    expect(result.isError).toBe(true);

    await client.close();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// E2E: McpConnection with real MCP server
// ---------------------------------------------------------------------------

describe("E2E: McpConnection with real MCP server", () => {
  test("connect + listTools returns real tools", async () => {
    const { deps, cleanup } = createE2eFixture();
    const conn = createMcpConnection(
      resolveServerConfig({ kind: "stdio", name: "e2e", command: "echo" }),
      undefined,
      deps,
    );

    const connectResult = await conn.connect();
    expect(connectResult.ok).toBe(true);
    expect(conn.state.kind).toBe("connected");

    const toolsResult = await conn.listTools();
    expect(toolsResult.ok).toBe(true);
    if (toolsResult.ok) {
      expect(toolsResult.value).toHaveLength(3);
      expect(toolsResult.value.map((t) => t.name).sort()).toEqual(["add", "echo", "fail"]);
    }

    await conn.close();
    await cleanup();
  });

  test("callTool executes real tool and returns result", async () => {
    const { deps, cleanup } = createE2eFixture();
    const conn = createMcpConnection(
      resolveServerConfig({ kind: "stdio", name: "e2e", command: "echo" }),
      undefined,
      deps,
    );

    await conn.connect();
    const result = await conn.callTool("add", { a: 10, b: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const content = result.value as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toBe("30");
    }

    await conn.close();
    await cleanup();
  });

  test("callTool with isError returns error result", async () => {
    const { deps, cleanup } = createE2eFixture();
    const conn = createMcpConnection(
      resolveServerConfig({ kind: "stdio", name: "e2e", command: "echo" }),
      undefined,
      deps,
    );

    await conn.connect();
    const result = await conn.callTool("fail", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("Something went wrong");
    }

    await conn.close();
    await cleanup();
  });

  test("state transitions fire during full lifecycle", async () => {
    const { deps, cleanup } = createE2eFixture();
    const conn = createMcpConnection(
      resolveServerConfig({ kind: "stdio", name: "e2e", command: "echo" }),
      undefined,
      deps,
    );

    const states: string[] = [];
    conn.onStateChange((s) => states.push(s.kind));

    await conn.connect();
    await conn.close();

    expect(states).toContain("connecting");
    expect(states).toContain("connected");
    expect(states).toContain("closed");
    await cleanup();
  });

  test("close prevents further operations", async () => {
    const { deps, cleanup } = createE2eFixture();
    const conn = createMcpConnection(
      resolveServerConfig({ kind: "stdio", name: "e2e", command: "echo" }),
      undefined,
      deps,
    );

    await conn.connect();
    await conn.close();
    expect(conn.state.kind).toBe("closed");

    const result = await conn.listTools();
    expect(result.ok).toBe(false);
    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// E2E: Full .mcp.json pipeline
// ---------------------------------------------------------------------------

describe("E2E: .mcp.json → normalize → resolve → connect → tool call", () => {
  test("full pipeline from CC-format JSON to tool call", async () => {
    const { deps, cleanup } = createE2eFixture();

    // Step 1: Parse CC-format .mcp.json
    const loadResult = loadMcpJsonString(
      JSON.stringify({
        mcpServers: {
          "test-server": { command: "echo", args: ["hello"] },
          "remote-server": { type: "http", url: "https://example.com/mcp" },
        },
      }),
    );
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;
    expect(loadResult.value.servers).toHaveLength(2);

    // Step 2: Resolve the stdio server
    const stdioServer = loadResult.value.servers.find((s) => s.name === "test-server");
    expect(stdioServer).toBeDefined();
    const resolved = resolveServerConfig(stdioServer!);
    expect(resolved.timeoutMs).toBe(30_000);

    // Step 3: Connect (using InMemoryTransport DI to wire to real server)
    const conn = createMcpConnection(resolved, undefined, deps);
    const connectResult = await conn.connect();
    expect(connectResult.ok).toBe(true);

    // Step 4: List tools
    const toolsResult = await conn.listTools();
    expect(toolsResult.ok).toBe(true);
    if (toolsResult.ok) {
      expect(toolsResult.value).toHaveLength(3);
    }

    // Step 5: Call a tool
    const callResult = await conn.callTool("add", { a: 100, b: 200 });
    expect(callResult.ok).toBe(true);
    if (callResult.ok) {
      const content = callResult.value as Array<{ type: string; text: string }>;
      expect(content[0]?.text).toBe("300");
    }

    await conn.close();
    await cleanup();
  });
});

// ---------------------------------------------------------------------------
// E2E: .mcp.json normalization (no server needed)
// ---------------------------------------------------------------------------

describe("E2E: CC config normalization", () => {
  test("real-world sentry + local + corridor config", () => {
    const { servers, unsupported } = normalizeMcpServers({
      sentry: { type: "http", url: "https://mcp.sentry.dev/mcp" },
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
    });

    expect(servers).toHaveLength(3);
    expect(unsupported).toHaveLength(0);

    const sentry = servers.find((s) => s.name === "sentry");
    expect(sentry?.kind).toBe("http");
    if (sentry?.kind === "http") expect(sentry.url).toBe("https://mcp.sentry.dev/mcp");

    const local = servers.find((s) => s.name === "my-local-server");
    expect(local?.kind).toBe("stdio");
    if (local?.kind === "stdio") {
      expect(local.command).toBe("npx");
      expect(local.args).toEqual(["my-mcp-server"]);
      expect(local.env).toEqual({ API_KEY: "test-key" });
    }
  });

  test("mixed supported/unsupported types", () => {
    const result = loadMcpJsonString(
      JSON.stringify({
        mcpServers: {
          good: { type: "http", url: "https://example.com" },
          ws: { type: "ws", url: "wss://example.com" },
          sdk: { type: "sdk", name: "vscode" },
          "also-good": { command: "npx", args: ["my-server"] },
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.servers).toHaveLength(2);
      expect(result.value.unsupported).toHaveLength(2);
    }
  });

  test("env var expansion with ${VAR:-default}", () => {
    process.env.E2E_MCP_URL = "https://real.example.com";
    delete process.env.E2E_MISSING;
    try {
      const result = loadMcpJsonString(
        JSON.stringify({
          mcpServers: {
            a: { type: "http", url: "${E2E_MCP_URL}" },
            b: { type: "http", url: "https://${E2E_MISSING:-fallback.com}/mcp" },
          },
        }),
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        const a = result.value.servers.find((s) => s.name === "a");
        const b = result.value.servers.find((s) => s.name === "b");
        if (a?.kind === "http") expect(a.url).toBe("https://real.example.com");
        if (b?.kind === "http") expect(b.url).toBe("https://fallback.com/mcp");
      }
    } finally {
      delete process.env.E2E_MCP_URL;
    }
  });

  test("headersHelper and oauth are rejected with clear error", () => {
    const { servers, rejected } = normalizeMcpServers({
      "oauth-server": {
        type: "http",
        url: "https://example.com",
        headersHelper: "/path/to/helper.sh",
        oauth: { clientId: "my-client", callbackPort: 8080 },
      },
    });
    // Server is rejected — not silently accepted
    expect(servers).toHaveLength(0);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toContain("headersHelper");
  });
});

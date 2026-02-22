/**
 * Mock-based tests for createMcpComponentProviderAsync.
 *
 * Uses the optional createManager parameter (dependency injection) to test
 * both "tools" and "discover" mode success paths without real MCP servers.
 */

import { describe, expect, test } from "bun:test";
import type { Agent, Tool } from "@koi/core";
import { toolToken } from "@koi/core";
import type { McpClientManager } from "./client-manager.js";
import { createMcpComponentProviderAsync } from "./component-provider.js";
import type { McpProviderConfig, ResolvedMcpServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgent(): Agent {
  return {
    pid: { id: "test-1", name: "test", type: "worker", depth: 0 },
    manifest: {
      name: "test-agent",
      version: "1.0.0",
      model: { name: "test-model" },
      tools: [],
      channels: [],
      middleware: [],
    },
    state: "running",
    component: () => undefined,
    has: () => false,
    hasAll: () => false,
    query: () => new Map(),
    components: () => new Map(),
  };
}

function createSuccessfulMockManager(
  name: string,
  tools: Array<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: { readonly type: string };
  }>,
  callResults: Readonly<Record<string, unknown>> = {},
): McpClientManager {
  let connected = false;
  return {
    connect: async () => {
      connected = true;
      return { ok: true as const, value: undefined };
    },
    listTools: async () => ({
      ok: true as const,
      value: tools,
    }),
    callTool: async (toolName, _args) => {
      const result = callResults[toolName];
      if (result === undefined) {
        return {
          ok: false as const,
          error: {
            code: "NOT_FOUND" as const,
            message: `Tool "${toolName}" not found`,
            retryable: false,
          },
        };
      }
      return { ok: true as const, value: result };
    },
    close: async () => {
      connected = false;
    },
    isConnected: () => connected,
    serverName: () => name,
  };
}

function createFailConnectManager(name: string): McpClientManager {
  return {
    connect: async () => ({
      ok: false as const,
      error: {
        code: "EXTERNAL" as const,
        message: `Mock connection failed for "${name}"`,
        retryable: false,
        context: { serverName: name },
      },
    }),
    listTools: async () => ({
      ok: false as const,
      error: {
        code: "EXTERNAL" as const,
        message: "Not connected",
        retryable: false,
      },
    }),
    callTool: async () => ({
      ok: false as const,
      error: {
        code: "EXTERNAL" as const,
        message: "Not connected",
        retryable: false,
      },
    }),
    close: async () => {},
    isConnected: () => false,
    serverName: () => name,
  };
}

function createFailListToolsManager(name: string): McpClientManager {
  let connected = false;
  return {
    connect: async () => {
      connected = true;
      return { ok: true as const, value: undefined };
    },
    listTools: async () => ({
      ok: false as const,
      error: {
        code: "EXTERNAL" as const,
        message: `Failed to list tools on "${name}"`,
        retryable: false,
      },
    }),
    callTool: async () => ({
      ok: false as const,
      error: {
        code: "EXTERNAL" as const,
        message: "Not available",
        retryable: false,
      },
    }),
    close: async () => {
      connected = false;
    },
    isConnected: () => connected,
    serverName: () => name,
  };
}

/** Creates a mock createManager factory that returns managers from a registry. */
function createMockFactory(
  registry: ReadonlyMap<string, McpClientManager>,
): (
  config: ResolvedMcpServerConfig,
  connectTimeoutMs: number,
  maxReconnectAttempts: number,
) => McpClientManager {
  return (config) => {
    const manager = registry.get(config.name);
    if (manager === undefined) {
      throw new Error(`No mock manager registered for "${config.name}"`);
    }
    return manager;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpComponentProviderAsync (with mock factory)", () => {
  // ---- tools mode ----

  test("tools mode: creates individual tool components on success", async () => {
    const registry = new Map<string, McpClientManager>([
      [
        "filesystem",
        createSuccessfulMockManager("filesystem", [
          {
            name: "read_file",
            description: "Reads a file",
            inputSchema: { type: "object" },
          },
          {
            name: "write_file",
            description: "Writes a file",
            inputSchema: { type: "object" },
          },
        ]),
      ],
    ]);

    const config: McpProviderConfig = {
      servers: [
        {
          name: "filesystem",
          transport: "stdio",
          command: "echo",
          mode: "tools",
        },
      ],
    };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(registry));
    expect(result.failures).toHaveLength(0);
    expect(result.clients).toHaveLength(1);

    const agent = createMockAgent();
    const components = await result.provider.attach(agent);
    expect(components.size).toBe(2);
    expect(components.has(toolToken("mcp/filesystem/read_file") as string)).toBe(true);
    expect(components.has(toolToken("mcp/filesystem/write_file") as string)).toBe(true);
  });

  test("tools mode: tool execute delegates to client callTool", async () => {
    const registry = new Map<string, McpClientManager>([
      [
        "fs",
        createSuccessfulMockManager(
          "fs",
          [
            {
              name: "read",
              description: "Read file",
              inputSchema: { type: "object" },
            },
          ],
          { read: [{ type: "text", text: "hello" }] },
        ),
      ],
    ]);

    const config: McpProviderConfig = {
      servers: [{ name: "fs", transport: "stdio", command: "echo", mode: "tools" }],
    };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(registry));
    const agent = createMockAgent();
    const components = await result.provider.attach(agent);

    const tool = components.get(toolToken("mcp/fs/read") as string) as Tool;
    expect(tool).toBeDefined();

    const execResult = await tool.execute({ path: "/test" });
    expect(execResult).toEqual([{ type: "text", text: "hello" }]);
  });

  // ---- discover mode ----

  test("discover mode: creates search and execute meta-tools", async () => {
    const registry = new Map<string, McpClientManager>([
      [
        "api",
        createSuccessfulMockManager("api", [
          {
            name: "get_user",
            description: "Get user",
            inputSchema: { type: "object" },
          },
          {
            name: "create_user",
            description: "Create user",
            inputSchema: { type: "object" },
          },
        ]),
      ],
    ]);

    const config: McpProviderConfig = {
      servers: [
        {
          name: "api",
          transport: "stdio",
          command: "echo",
          mode: "discover",
        },
      ],
    };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(registry));
    expect(result.failures).toHaveLength(0);
    expect(result.clients).toHaveLength(1);

    const agent = createMockAgent();
    const components = await result.provider.attach(agent);
    expect(components.size).toBe(2);
    expect(components.has(toolToken("mcp/api/mcp_search") as string)).toBe(true);
    expect(components.has(toolToken("mcp/api/mcp_execute") as string)).toBe(true);
  });

  // ---- failure handling ----

  test("records failure when server fails to connect", async () => {
    const registry = new Map<string, McpClientManager>([
      ["bad-server", createFailConnectManager("bad-server")],
    ]);

    const config: McpProviderConfig = {
      servers: [{ name: "bad-server", transport: "stdio", command: "echo" }],
    };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(registry));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.serverName).toBe("bad-server");
    expect(result.clients).toHaveLength(0);
  });

  test("records failure when listTools fails in tools mode", async () => {
    const registry = new Map<string, McpClientManager>([
      ["broken-tools", createFailListToolsManager("broken-tools")],
    ]);

    const config: McpProviderConfig = {
      servers: [
        {
          name: "broken-tools",
          transport: "stdio",
          command: "echo",
          mode: "tools",
        },
      ],
    };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(registry));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.serverName).toBe("broken-tools");
    expect(result.clients).toHaveLength(0);
  });

  test("records failure when listTools fails in discover mode", async () => {
    const registry = new Map<string, McpClientManager>([
      ["broken-discover", createFailListToolsManager("broken-discover")],
    ]);

    const config: McpProviderConfig = {
      servers: [
        {
          name: "broken-discover",
          transport: "stdio",
          command: "echo",
          mode: "discover",
        },
      ],
    };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(registry));
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.serverName).toBe("broken-discover");
  });

  test("handles mixed success and failure across servers", async () => {
    const registry = new Map<string, McpClientManager>([
      [
        "healthy",
        createSuccessfulMockManager("healthy", [
          {
            name: "ping",
            description: "Ping",
            inputSchema: { type: "object" },
          },
        ]),
      ],
      ["broken", createFailConnectManager("broken")],
    ]);

    const config: McpProviderConfig = {
      servers: [
        {
          name: "healthy",
          transport: "stdio",
          command: "echo",
          mode: "tools",
        },
        {
          name: "broken",
          transport: "stdio",
          command: "echo",
          mode: "tools",
        },
      ],
    };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(registry));
    expect(result.clients).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.serverName).toBe("broken");

    const agent = createMockAgent();
    const components = await result.provider.attach(agent);
    expect(components.size).toBe(1);
    expect(components.has(toolToken("mcp/healthy/ping") as string)).toBe(true);
  });

  test("returns empty results when no servers configured", async () => {
    const config: McpProviderConfig = { servers: [] };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(new Map()));
    expect(result.clients).toHaveLength(0);
    expect(result.failures).toHaveLength(0);

    const agent = createMockAgent();
    const components = await result.provider.attach(agent);
    expect(components.size).toBe(0);
  });

  test("multiple servers in tools mode all contribute tools", async () => {
    const registry = new Map<string, McpClientManager>([
      [
        "fs",
        createSuccessfulMockManager("fs", [
          {
            name: "read",
            description: "Read",
            inputSchema: { type: "object" },
          },
        ]),
      ],
      [
        "git",
        createSuccessfulMockManager("git", [
          {
            name: "commit",
            description: "Commit",
            inputSchema: { type: "object" },
          },
          {
            name: "push",
            description: "Push",
            inputSchema: { type: "object" },
          },
        ]),
      ],
    ]);

    const config: McpProviderConfig = {
      servers: [
        { name: "fs", transport: "stdio", command: "echo", mode: "tools" },
        { name: "git", transport: "stdio", command: "echo", mode: "tools" },
      ],
    };

    const result = await createMcpComponentProviderAsync(config, createMockFactory(registry));
    expect(result.clients).toHaveLength(2);
    expect(result.failures).toHaveLength(0);

    const agent = createMockAgent();
    const components = await result.provider.attach(agent);
    expect(components.size).toBe(3);
  });
});

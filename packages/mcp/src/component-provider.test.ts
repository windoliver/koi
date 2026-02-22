import { describe, expect, test } from "bun:test";
import { createMcpComponentProviderAsync } from "./component-provider.js";
import type { McpProviderConfig } from "./config.js";

/**
 * Component provider tests use invalid server configs to test failure paths.
 * Full lifecycle tests are in __tests__/integration.test.ts with mock managers.
 */

describe("createMcpComponentProviderAsync", () => {
  test("returns provider with name 'mcp'", async () => {
    const config: McpProviderConfig = {
      servers: [
        {
          name: "bad-server",
          transport: "stdio",
          command: "nonexistent-command-xyz",
        },
      ],
      connectTimeoutMs: 1_000,
      maxReconnectAttempts: 0,
    };

    const result = await createMcpComponentProviderAsync(config);
    expect(result.provider.name).toBe("mcp");
  });

  test("records failures for servers that fail to connect", async () => {
    const config: McpProviderConfig = {
      servers: [
        {
          name: "bad-server",
          transport: "stdio",
          command: "nonexistent-command-xyz",
        },
      ],
      connectTimeoutMs: 1_000,
      maxReconnectAttempts: 0,
    };

    const result = await createMcpComponentProviderAsync(config);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.serverName).toBe("bad-server");
    expect(result.clients).toHaveLength(0);
  });

  test("attach returns empty map when all servers fail", async () => {
    const config: McpProviderConfig = {
      servers: [
        {
          name: "bad-1",
          transport: "stdio",
          command: "nonexistent-xyz-1",
        },
        {
          name: "bad-2",
          transport: "stdio",
          command: "nonexistent-xyz-2",
        },
      ],
      connectTimeoutMs: 1_000,
      maxReconnectAttempts: 0,
    };

    const result = await createMcpComponentProviderAsync(config);
    expect(result.failures).toHaveLength(2);

    const agent = createMockAgent();
    const components = await result.provider.attach(agent);
    expect(components.size).toBe(0);
  });

  test("returns result with provider, clients, and failures arrays", async () => {
    const config: McpProviderConfig = {
      servers: [
        {
          name: "bad-server",
          transport: "stdio",
          command: "nonexistent-command-xyz",
        },
      ],
      connectTimeoutMs: 1_000,
      maxReconnectAttempts: 0,
    };

    const result = await createMcpComponentProviderAsync(config);
    expect(result).toHaveProperty("provider");
    expect(result).toHaveProperty("clients");
    expect(result).toHaveProperty("failures");
    expect(Array.isArray(result.clients)).toBe(true);
    expect(Array.isArray(result.failures)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockAgent(): import("@koi/core").Agent {
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

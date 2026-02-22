import { describe, expect, test } from "bun:test";
import { createMcpClientManager } from "./client-manager.js";
import type { ResolvedMcpServerConfig } from "./config.js";

/**
 * Note: These tests mock the transport/Client layer. We cannot easily
 * test actual MCP client connections in unit tests because they require
 * a real MCP server process. Integration tests cover the full lifecycle.
 *
 * We test the manager's logic: error handling, state management, and
 * the interface it exposes.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConfig(name = "test-server"): ResolvedMcpServerConfig {
  return {
    name,
    transport: {
      transport: "stdio",
      command: "echo",
      args: ["hello"],
    },
    mode: "tools",
    timeoutMs: 30_000,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpClientManager", () => {
  test("creates a manager with correct server name", () => {
    const config = createTestConfig("my-server");
    const manager = createMcpClientManager(config, 10_000, 3);

    expect(manager.serverName()).toBe("my-server");
  });

  test("starts not connected", () => {
    const config = createTestConfig();
    const manager = createMcpClientManager(config, 10_000, 3);

    expect(manager.isConnected()).toBe(false);
  });

  test("connect returns error for invalid command", async () => {
    const config: ResolvedMcpServerConfig = {
      name: "bad-server",
      transport: {
        transport: "stdio",
        command: "nonexistent-command-that-does-not-exist-xyz",
      },
      mode: "tools",
      timeoutMs: 30_000,
    };
    const manager = createMcpClientManager(config, 5_000, 0);

    const result = await manager.connect();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context).toEqual({ serverName: "bad-server" });
    }
  });

  test("close is safe to call when not connected", async () => {
    const config = createTestConfig();
    const manager = createMcpClientManager(config, 10_000, 3);

    await manager.close();
    expect(manager.isConnected()).toBe(false);
  });

  test("listTools returns error when not connected and reconnect fails", async () => {
    const config: ResolvedMcpServerConfig = {
      name: "bad-server",
      transport: {
        transport: "stdio",
        command: "nonexistent-command-xyz",
      },
      mode: "tools",
      timeoutMs: 30_000,
    };
    const manager = createMcpClientManager(config, 1_000, 0);

    const result = await manager.listTools();
    expect(result.ok).toBe(false);
  });

  test("callTool returns error when not connected and reconnect fails", async () => {
    const config: ResolvedMcpServerConfig = {
      name: "bad-server",
      transport: {
        transport: "stdio",
        command: "nonexistent-command-xyz",
      },
      mode: "tools",
      timeoutMs: 30_000,
    };
    const manager = createMcpClientManager(config, 1_000, 0);

    const result = await manager.callTool("some-tool", {});
    expect(result.ok).toBe(false);
  });

  test("exposes connect, listTools, callTool, close, isConnected, serverName methods", () => {
    const config = createTestConfig();
    const manager = createMcpClientManager(config, 10_000, 3);

    expect(typeof manager.connect).toBe("function");
    expect(typeof manager.listTools).toBe("function");
    expect(typeof manager.callTool).toBe("function");
    expect(typeof manager.close).toBe("function");
    expect(typeof manager.isConnected).toBe("function");
    expect(typeof manager.serverName).toBe("function");
  });
});

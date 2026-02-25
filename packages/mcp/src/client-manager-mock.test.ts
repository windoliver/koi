/**
 * Mock-based tests for createMcpClientManager.
 *
 * Uses dependency injection (ClientManagerDeps) to replace the MCP SDK Client
 * and transport layer, enabling us to test connect success, listTools, callTool,
 * close, reconnection, and timeout paths without a real MCP server.
 *
 * No mock.module() — avoids global mock bleeding across test files.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { type ClientManagerDeps, createMcpClientManager } from "./client-manager.js";
import type { ResolvedMcpServerConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Mock state — reset per test via beforeEach
// ---------------------------------------------------------------------------

let mockConnectBehavior: "succeed" | "fail" | "hang" = "succeed";
let mockListToolsResult: {
  tools: Array<{ name: string; description?: string; inputSchema?: object }>;
} = { tools: [] };
let mockCallToolResult: { content: unknown[]; isError?: boolean } = {
  content: [],
};
let mockCallToolShouldThrow = false;
let mockCloseShouldThrow = false;

let connectCallCount = 0;
let closeCallCount = 0;
let callToolCalls: Array<{
  name: string;
  arguments: Record<string, unknown>;
}> = [];
// Track pending "hang" resolve callbacks for cleanup (justified: mutable state for test lifecycle)
let pendingHangResolvers: Array<() => void> = [];

function resetMockState(): void {
  mockConnectBehavior = "succeed";
  mockListToolsResult = { tools: [] };
  mockCallToolResult = { content: [] };
  mockCallToolShouldThrow = false;
  mockCloseShouldThrow = false;
  connectCallCount = 0;
  closeCallCount = 0;
  callToolCalls = [];
  // Resolve any lingering hang promises from previous tests
  for (const resolve of pendingHangResolvers) {
    resolve();
  }
  pendingHangResolvers = [];
}

// ---------------------------------------------------------------------------
// Mock deps — injected into createMcpClientManager
// ---------------------------------------------------------------------------

function createMockDeps(): ClientManagerDeps {
  return {
    createClient: (_info) => {
      // Manual resolve callback to cancel pending "hang" connects when close() is called.
      // Avoids AbortController and setTimeout — bare promise prevents DOMException leaks
      // that Bun's test runner reports as "Unhandled error between tests" under parallel load.
      // let justified: mutable ref to settle pending hang promise from close()
      let hangResolve: (() => void) | undefined;

      return {
        async connect(_transport: unknown): Promise<void> {
          connectCallCount += 1;
          if (mockConnectBehavior === "fail") {
            throw new Error("Connection refused");
          }
          if (mockConnectBehavior === "hang") {
            // Bare promise — never resolves naturally; settled via close() or resetMockState
            return new Promise<void>((resolve) => {
              hangResolve = resolve;
              pendingHangResolvers.push(resolve);
            });
          }
        },
        async close(): Promise<void> {
          // Settle any pending "hang" connect promise so it doesn't leak
          if (hangResolve !== undefined) {
            hangResolve();
            hangResolve = undefined;
          }
          closeCallCount += 1;
          if (mockCloseShouldThrow) {
            throw new Error("Close error");
          }
        },
        async listTools() {
          return mockListToolsResult;
        },
        async callTool(params: { name: string; arguments: Record<string, unknown> }) {
          callToolCalls.push(params);
          if (mockCallToolShouldThrow) {
            throw new Error("Tool execution error");
          }
          return mockCallToolResult;
        },
      };
    },
    createTransport: (_config) => ({}),
  };
}

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

describe("createMcpClientManager (mocked SDK)", () => {
  beforeEach(resetMockState);

  // ---- connect ----

  test("connect succeeds and sets isConnected to true", async () => {
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());

    const result = await manager.connect();
    expect(result.ok).toBe(true);
    expect(manager.isConnected()).toBe(true);
    expect(connectCallCount).toBe(1);
  });

  test("connect returns error on failure and stays disconnected", async () => {
    mockConnectBehavior = "fail";
    const manager = createMcpClientManager(
      createTestConfig("bad-server"),
      10_000,
      0,
      createMockDeps(),
    );

    const result = await manager.connect();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.context).toEqual({ serverName: "bad-server" });
    }
    expect(manager.isConnected()).toBe(false);
  });

  test("connect times out and returns TIMEOUT error", async () => {
    mockConnectBehavior = "hang";
    const manager = createMcpClientManager(
      createTestConfig("slow-server"),
      500,
      0,
      createMockDeps(),
    );

    const result = await manager.connect();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.message).toContain("slow-server");
    }
    await manager.close();
  }, 30_000);

  test("connect resets reconnect attempt counter on success", async () => {
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());

    // First connect succeeds
    await manager.connect();
    expect(manager.isConnected()).toBe(true);

    // Simulate disconnect (callTool throws -> sets connected = false)
    mockCallToolShouldThrow = true;
    await manager.callTool("tool", {});
    expect(manager.isConnected()).toBe(false);

    // Second connect succeeds
    mockCallToolShouldThrow = false;
    mockConnectBehavior = "succeed";
    const result = await manager.connect();
    expect(result.ok).toBe(true);
    expect(manager.isConnected()).toBe(true);
  });

  // ---- listTools ----

  test("listTools returns tools when connected", async () => {
    mockListToolsResult = {
      tools: [
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
      ],
    };
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();

    const result = await manager.listTools();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.name).toBe("read_file");
      expect(result.value[0]?.description).toBe("Reads a file");
    }
  });

  test("listTools provides defaults for optional description and inputSchema", async () => {
    mockListToolsResult = {
      tools: [{ name: "tool1" }],
    };
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();

    const result = await manager.listTools();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.description).toBe("");
      expect(result.value[0]?.inputSchema).toEqual({ type: "object" });
    }
  });

  // ---- callTool ----

  test("callTool returns content on success", async () => {
    mockCallToolResult = {
      content: [{ type: "text", text: "Hello, world!" }],
    };
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();

    const result = await manager.callTool("read_file", {
      path: "/test.txt",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([{ type: "text", text: "Hello, world!" }]);
    }
    expect(callToolCalls).toHaveLength(1);
    expect(callToolCalls[0]).toEqual({
      name: "read_file",
      arguments: { path: "/test.txt" },
    });
  });

  test("callTool returns EXTERNAL error when isError is true", async () => {
    mockCallToolResult = {
      content: [{ type: "text", text: "File not found" }],
      isError: true,
    };
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();

    const result = await manager.callTool("read_file", {
      path: "/missing.txt",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("File not found");
      expect(result.error.context).toEqual({
        serverName: "test-server",
        toolName: "read_file",
      });
    }
  });

  test("callTool extracts error text from multiple text content blocks", async () => {
    mockCallToolResult = {
      content: [
        { type: "text", text: "Error line 1" },
        { type: "image", data: "base64..." },
        { type: "text", text: "Error line 2" },
      ],
      isError: true,
    };
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();

    const result = await manager.callTool("bad_tool", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Error line 1");
      expect(result.error.message).toContain("Error line 2");
    }
  });

  test("callTool handles isError with no text content blocks", async () => {
    mockCallToolResult = {
      content: [{ type: "image", data: "..." }],
      isError: true,
    };
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();

    const result = await manager.callTool("tool", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unknown error");
    }
  });

  test("callTool sets connected to false when client throws", async () => {
    mockCallToolShouldThrow = true;
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();
    expect(manager.isConnected()).toBe(true);

    const result = await manager.callTool("tool", {});
    expect(result.ok).toBe(false);
    expect(manager.isConnected()).toBe(false);
  });

  // ---- close ----

  test("close calls client.close and resets state", async () => {
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();
    expect(manager.isConnected()).toBe(true);

    await manager.close();
    expect(manager.isConnected()).toBe(false);
    expect(closeCallCount).toBe(1);
  });

  test("close is safe when not connected", async () => {
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.close();
    expect(manager.isConnected()).toBe(false);
    expect(closeCallCount).toBe(0);
  });

  test("close handles error from client.close gracefully", async () => {
    mockCloseShouldThrow = true;
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();

    // Should not throw
    await manager.close();
    expect(manager.isConnected()).toBe(false);
  });

  // ---- ensureConnected / reconnection ----

  test("ensureConnected returns ok immediately when already connected", async () => {
    const manager = createMcpClientManager(createTestConfig(), 10_000, 3, createMockDeps());
    await manager.connect();
    expect(connectCallCount).toBe(1);

    // listTools calls ensureConnected internally — should NOT trigger reconnect
    mockListToolsResult = {
      tools: [{ name: "tool1", description: "test", inputSchema: { type: "object" } }],
    };
    const result = await manager.listTools();
    expect(result.ok).toBe(true);
    // No additional connect calls
    expect(connectCallCount).toBe(1);
  });

  test("ensureConnected triggers reconnect when disconnected", async () => {
    // Start connected, then simulate disconnect
    // Use short backoff (50ms) to avoid timing issues under parallel load
    const manager = createMcpClientManager(createTestConfig(), 10_000, 1, createMockDeps(), 50);
    await manager.connect();

    // Simulate disconnect
    mockCallToolShouldThrow = true;
    await manager.callTool("tool", {});
    expect(manager.isConnected()).toBe(false);

    // Next operation should trigger reconnect
    mockCallToolShouldThrow = false;
    mockCallToolResult = {
      content: [{ type: "text", text: "reconnected" }],
    };
    const result = await manager.callTool("tool", {});
    expect(result.ok).toBe(true);
    expect(manager.isConnected()).toBe(true);
  }, 30_000);

  test("ensureConnected returns error when reconnect exhausted", async () => {
    mockConnectBehavior = "fail";
    const manager = createMcpClientManager(createTestConfig(), 10_000, 0, createMockDeps());

    // Not connected, maxReconnectAttempts=0 -> immediate exhaustion
    const result = await manager.listTools();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
      expect(result.error.message).toContain("reconnect");
    }
  });

  // ---- KoiError handling in connect ----

  test("connect returns KoiError directly when thrown error is KoiError", async () => {
    // The timeout path throws a KoiError (connectionTimeoutError) which
    // is detected by isKoiError() and returned directly without wrapping.
    mockConnectBehavior = "hang";
    const manager = createMcpClientManager(
      createTestConfig("timeout-server"),
      500,
      0,
      createMockDeps(),
    );

    const result = await manager.connect();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // connectionTimeoutError creates a KoiError with code: "TIMEOUT"
      expect(result.error.code).toBe("TIMEOUT");
      expect(result.error.retryable).toBe(true);
    }
    await manager.close();
  }, 30_000);
});

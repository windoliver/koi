import { describe, expect, mock, test } from "bun:test";
import { resolveServerConfig } from "./config.js";
import type { ConnectionDeps } from "./connection.js";
import { createMcpConnection } from "./connection.js";
import type { TransportState } from "./state.js";
import type { KoiMcpTransport, TransportEventListener } from "./transport.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockClient(options?: {
  readonly shouldFailConnect?: boolean;
  readonly tools?: readonly {
    name: string;
    description?: string;
    inputSchema?: unknown;
  }[];
  readonly callResults?: Readonly<Record<string, unknown>>;
  readonly capabilities?: { tools?: { listChanged?: boolean } };
}) {
  const { shouldFailConnect, tools = [], callResults = {}, capabilities } = options ?? {};
  // let justified: tracks connection state for mock
  let connected = false;

  const base = {
    connect: mock(async (_transport: unknown) => {
      if (shouldFailConnect) {
        throw new Error("connection refused");
      }
      connected = true;
    }),
    close: mock(async () => {
      connected = false;
    }),
    listTools: mock(async () => {
      if (!connected) throw new Error("not connected");
      return { tools: [...tools] };
    }),
    callTool: mock(async (params: { name: string; arguments: Record<string, unknown> }) => {
      if (!connected) throw new Error("not connected");
      const result = callResults[params.name];
      if (result === undefined) {
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: String(result) }] };
    }),
  };

  // Add optional notification handler methods only when capabilities warrant it
  if (capabilities?.tools?.listChanged === true) {
    return {
      ...base,
      setNotificationHandler: mock((_method: string, _handler: (params: unknown) => void) => {}),
      getServerCapabilities: mock(() => capabilities),
    };
  }

  if (capabilities !== undefined) {
    return {
      ...base,
      getServerCapabilities: mock(() => capabilities),
    };
  }

  return base;
}

function createMockTransport(): KoiMcpTransport & {
  _fireEvent: (
    event: { readonly kind: "closed" } | { readonly kind: "error"; readonly error: Error },
  ) => void;
} {
  const listeners = new Set<TransportEventListener>();
  return {
    start: mock(async () => {}),
    close: mock(async () => {}),
    sdkTransport: {},
    get sessionId() {
      return undefined;
    },
    onEvent: (listener: TransportEventListener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    _fireEvent: (event) => {
      for (const l of listeners) l(event);
    },
  };
}

function makeDeps(
  clientOverride?: ReturnType<typeof createMockClient>,
  transportOverride?: ReturnType<typeof createMockTransport>,
): Partial<ConnectionDeps> {
  const mockClient = clientOverride ?? createMockClient();
  const mockTransport = transportOverride ?? createMockTransport();
  return {
    createClient: (() => mockClient) as ConnectionDeps["createClient"],
    createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
  };
}

function makeConfig(overrides?: { maxReconnectAttempts?: number; connectTimeoutMs?: number }) {
  return resolveServerConfig({
    name: "test-server",
    transport: { transport: "stdio", command: "echo" },
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// connect
// ---------------------------------------------------------------------------

describe("McpConnection.connect", () => {
  test("transitions to connected on success", async () => {
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps());
    const result = await conn.connect();
    expect(result.ok).toBe(true);
    expect(conn.state.kind).toBe("connected");
  });

  test("transitions to error on failure", async () => {
    const mockClient = createMockClient({ shouldFailConnect: true });
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps(mockClient));
    const result = await conn.connect();
    expect(result.ok).toBe(false);
    expect(conn.state.kind).toBe("error");
  });

  test("fires state change listeners", async () => {
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps());
    const states: TransportState[] = [];
    conn.onStateChange((s) => states.push(s));

    await conn.connect();

    expect(states.length).toBeGreaterThanOrEqual(2);
    expect(states[0]?.kind).toBe("connecting");
    expect(states[states.length - 1]?.kind).toBe("connected");
  });

  test("exposes server name", () => {
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps());
    expect(conn.serverName).toBe("test-server");
  });
});

// ---------------------------------------------------------------------------
// listTools
// ---------------------------------------------------------------------------

describe("McpConnection.listTools", () => {
  test("returns tools after connect", async () => {
    const mockClient = createMockClient({
      tools: [
        {
          name: "echo",
          description: "Echo tool",
          inputSchema: { type: "object" },
        },
        { name: "add", description: "Add numbers" },
      ],
    });
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps(mockClient));

    await conn.connect();
    const result = await conn.listTools();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0]?.name).toBe("echo");
      expect(result.value[1]?.name).toBe("add");
      expect(result.value[1]?.description).toBe("Add numbers");
    }
  });

  test("returns empty description when not provided", async () => {
    const mockClient = createMockClient({
      tools: [{ name: "no-desc" }],
    });
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps(mockClient));

    await conn.connect();
    const result = await conn.listTools();

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]?.description).toBe("");
    }
  });
});

// ---------------------------------------------------------------------------
// callTool
// ---------------------------------------------------------------------------

describe("McpConnection.callTool", () => {
  test("returns tool result on success", async () => {
    const mockClient = createMockClient({
      tools: [{ name: "echo" }],
      callResults: { echo: "hello" },
    });
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps(mockClient));

    await conn.connect();
    const result = await conn.callTool("echo", { input: "hello" });
    expect(result.ok).toBe(true);
  });

  test("returns error for unknown tool", async () => {
    const mockClient = createMockClient({ callResults: {} });
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps(mockClient));

    await conn.connect();
    const result = await conn.callTool("nonexistent", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("EXTERNAL");
    }
  });
});

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

describe("McpConnection.close", () => {
  test("transitions to closed", async () => {
    const mockClient = createMockClient();
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps(mockClient));

    await conn.connect();
    await conn.close();
    expect(conn.state.kind).toBe("closed");
  });

  test("calls client.close()", async () => {
    const mockClient = createMockClient();
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps(mockClient));

    await conn.connect();
    await conn.close();
    expect(mockClient.close).toHaveBeenCalled();
  });

  test("prevents operations after close", async () => {
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps());

    await conn.connect();
    await conn.close();

    const result = await conn.listTools();
    expect(result.ok).toBe(false);
  });

  test("is idempotent", async () => {
    const conn = createMcpConnection(makeConfig(), undefined, makeDeps());

    await conn.connect();
    await conn.close();
    await conn.close(); // should not throw
    expect(conn.state.kind).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// reconnection
// ---------------------------------------------------------------------------

describe("McpConnection reconnection", () => {
  test("reconnects on successful retry", async () => {
    const mockClient = createMockClient();
    const conn = createMcpConnection(makeConfig({ maxReconnectAttempts: 2 }), undefined, {
      ...makeDeps(mockClient),
      random: () => 0, // No jitter for fast tests
    });

    const result = await conn.connect();
    expect(result.ok).toBe(true);
  });

  test("gives up after max reconnect attempts", async () => {
    const mockClient = createMockClient({ shouldFailConnect: true });
    const conn = createMcpConnection(makeConfig({ maxReconnectAttempts: 0 }), undefined, {
      ...makeDeps(mockClient),
      random: () => 0,
    });

    const result = await conn.connect();
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// tool change notifications
// ---------------------------------------------------------------------------

describe("McpConnection.onToolsChanged", () => {
  test("subscribes to tool change events", async () => {
    // let justified: captures notification handler for manual trigger
    let notificationHandler: ((params: unknown) => void) | undefined;
    const mockClient = {
      connect: mock(async () => {}),
      close: mock(async () => {}),
      listTools: mock(async () => ({ tools: [] as { name: string }[] })),
      callTool: mock(async () => ({ content: [] as Record<string, unknown>[] })),
      setNotificationHandler: mock((method: string, handler: (params: unknown) => void) => {
        if (method === "notifications/tools/list_changed") {
          notificationHandler = handler;
        }
      }),
      getServerCapabilities: mock(() => ({
        tools: { listChanged: true },
      })),
    };

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => createMockTransport()) as ConnectionDeps["createTransport"],
    });

    const listener = mock(() => {});
    conn.onToolsChanged(listener);

    await conn.connect();

    expect(notificationHandler).toBeDefined();
    notificationHandler?.(undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  test("unsubscribe stops notifications", async () => {
    // let justified: captures notification handler
    let notificationHandler: ((params: unknown) => void) | undefined;
    const mockClient = {
      connect: mock(async () => {}),
      close: mock(async () => {}),
      listTools: mock(async () => ({ tools: [] as { name: string }[] })),
      callTool: mock(async () => ({ content: [] as Record<string, unknown>[] })),
      setNotificationHandler: mock((_method: string, handler: (params: unknown) => void) => {
        notificationHandler = handler;
      }),
      getServerCapabilities: mock(() => ({
        tools: { listChanged: true },
      })),
    };

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => createMockTransport()) as ConnectionDeps["createTransport"],
    });

    const listener = mock(() => {});
    const unsub = conn.onToolsChanged(listener);
    await conn.connect();

    notificationHandler?.(undefined);
    expect(listener).toHaveBeenCalledTimes(1);

    unsub();
    notificationHandler?.(undefined);
    expect(listener).toHaveBeenCalledTimes(1); // not called again
  });

  test("does not subscribe when server lacks listChanged capability", async () => {
    const setNotificationHandler = mock(
      (_method: string, _handler: (params: unknown) => void) => {},
    );
    const mockClient = {
      connect: mock(async () => {}),
      close: mock(async () => {}),
      listTools: mock(async () => ({ tools: [] as { name: string }[] })),
      callTool: mock(async () => ({ content: [] as Record<string, unknown>[] })),
      setNotificationHandler,
      getServerCapabilities: mock(() => ({
        tools: { listChanged: false },
      })),
    };

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => createMockTransport()) as ConnectionDeps["createTransport"],
    });

    await conn.connect();
    expect(setNotificationHandler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// auth provider integration
// ---------------------------------------------------------------------------

describe("McpConnection with auth provider", () => {
  test("passes auth provider to transport factory", async () => {
    const auth = { token: () => "my-token" };
    const transportFactory = mock(() => createMockTransport() as KoiMcpTransport);

    const conn = createMcpConnection(makeConfig(), auth, {
      createClient: (() => createMockClient()) as ConnectionDeps["createClient"],
      createTransport: transportFactory,
    });

    await conn.connect();
    expect(transportFactory).toHaveBeenCalledTimes(1);
    const calls = transportFactory.mock.calls as unknown as Array<[{ authProvider?: unknown }]>;
    expect(calls[0]?.[0]?.authProvider).toBe(auth);
  });
});

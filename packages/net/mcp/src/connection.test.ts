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
  return resolveServerConfig({ kind: "stdio", name: "test-server", command: "echo" }, overrides);
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
// transport error event handling
// ---------------------------------------------------------------------------

describe("McpConnection transport error events", () => {
  test("transport error event transitions state to error", async () => {
    const mockTransport = createMockTransport();
    const conn = createMcpConnection(makeConfig(), undefined, {
      ...makeDeps(undefined, mockTransport),
    });

    await conn.connect();
    expect(conn.state.kind).toBe("connected");

    // Simulate transport error
    mockTransport._fireEvent({ kind: "error", error: new Error("connection reset") });
    expect(conn.state.kind).toBe("error");
  });

  test("transport closed event transitions state to error", async () => {
    const mockTransport = createMockTransport();
    const conn = createMcpConnection(makeConfig(), undefined, {
      ...makeDeps(undefined, mockTransport),
    });

    await conn.connect();
    mockTransport._fireEvent({ kind: "closed" });
    expect(conn.state.kind).toBe("error");
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
// onAuthNeeded pause-and-retry
// ---------------------------------------------------------------------------

describe("McpConnection onAuthNeeded pause-and-retry", () => {
  // Helper: build a client whose listTools/callTool throws a 401 on the first
  // call, then succeeds on subsequent calls.
  function createUnauthorizedOnFirstCallClient(options?: {
    readonly tools?: readonly { name: string; description?: string; inputSchema?: unknown }[];
    readonly callResults?: Readonly<Record<string, unknown>>;
  }) {
    const { tools = [], callResults = {} } = options ?? {};
    // let justified: tracks whether the first call has been made
    let listToolsCallCount = 0;
    let callToolCallCount = 0;

    return {
      connect: mock(async (_transport: unknown) => {}),
      close: mock(async () => {}),
      listTools: mock(async () => {
        listToolsCallCount++;
        if (listToolsCallCount === 1) {
          throw new Error("401 Unauthorized");
        }
        return { tools: [...tools] };
      }),
      callTool: mock(async (params: { name: string; arguments: Record<string, unknown> }) => {
        callToolCallCount++;
        if (callToolCallCount === 1) {
          throw new Error("401 Unauthorized");
        }
        const result = callResults[params.name];
        if (result === undefined) {
          return {
            content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
            isError: true,
          };
        }
        return { content: [{ type: "text", text: String(result) }] };
      }),
      get _listToolsCallCount() {
        return listToolsCallCount;
      },
      get _callToolCallCount() {
        return callToolCallCount;
      },
    };
  }

  test("callTool — onAuthNeeded returns true → reconnects and retries → returns result", async () => {
    const mockClient = createUnauthorizedOnFirstCallClient({
      callResults: { echo: "hello" },
    });
    const mockTransport = createMockTransport();
    const onAuthNeeded = mock(async () => true);

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded,
    });

    await conn.connect();
    const result = await conn.callTool("echo", {});

    expect(onAuthNeeded).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  test("callTool — onAuthNeeded returns false → returns AUTH_REQUIRED error without retry", async () => {
    const mockClient = createUnauthorizedOnFirstCallClient({
      callResults: { echo: "hello" },
    });
    const mockTransport = createMockTransport();
    const onAuthNeeded = mock(async () => false);

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded,
    });

    await conn.connect();
    const result = await conn.callTool("echo", {});

    expect(onAuthNeeded).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_REQUIRED");
    }
    // callTool should not have been retried
    expect(mockClient._callToolCallCount).toBe(1);
  });

  test("callTool — onAuthNeeded absent → falls back to onUnauthorized, returns AUTH_REQUIRED error", async () => {
    const mockClient = createUnauthorizedOnFirstCallClient({
      callResults: { echo: "hello" },
    });
    const mockTransport = createMockTransport();
    const onUnauthorized = mock(async () => "needs-auth" as const);

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onUnauthorized,
    });

    await conn.connect();
    const result = await conn.callTool("echo", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_REQUIRED");
    }
    // onUnauthorized should have been called as fallback
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    // No retry was attempted
    expect(mockClient._callToolCallCount).toBe(1);
  });

  test("listTools — 401 transitions to auth-needed and returns AUTH_REQUIRED without interactive auth", async () => {
    // listTools is passive (discovery/status) — 401 must NOT launch the OAuth flow.
    // Interactive auth is reserved for explicit callTool invocations.
    const mockClient = createUnauthorizedOnFirstCallClient({
      tools: [{ name: "my-tool", description: "A tool", inputSchema: { type: "object" } }],
    });
    const mockTransport = createMockTransport();
    const onAuthNeeded = mock(async () => true);

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded,
    });

    await conn.connect();
    const result = await conn.listTools();

    expect(onAuthNeeded).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("AUTH_REQUIRED");
    }
    expect(conn.state.kind).toBe("auth-needed");
  });

  test("callTool — onAuthNeeded returns true but reconnect fails → returns real reconnect error", async () => {
    // let justified: tracks how many times connect was attempted
    let connectAttempt = 0;
    const mockTransport = createMockTransport();

    const alwaysFailAfterFirstConnectClient = {
      connect: mock(async (_transport: unknown) => {
        connectAttempt++;
        if (connectAttempt > 1) {
          throw new Error("connection refused");
        }
      }),
      close: mock(async () => {}),
      listTools: mock(async () => ({ tools: [] as { name: string }[] })),
      callTool: mock(async (_params: { name: string; arguments: Record<string, unknown> }) => {
        throw new Error("401 Unauthorized");
      }),
    };
    const onAuthNeeded = mock(async () => true);

    const conn = createMcpConnection(makeConfig({ maxReconnectAttempts: 0 }), undefined, {
      createClient: (() => alwaysFailAfterFirstConnectClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded,
      random: () => 0,
    });

    await conn.connect();
    const result = await conn.callTool("echo", {});

    expect(onAuthNeeded).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    // Auth succeeded but reconnect failed — surfaces the real transport error,
    // not the original AUTH_REQUIRED, so callers can distinguish transport
    // outages from actual auth failures.
    if (!result.ok) {
      expect(result.error.code).not.toBe("AUTH_REQUIRED");
    }
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

// ---------------------------------------------------------------------------
// OAuth inline flow integration
// ---------------------------------------------------------------------------

describe("MCP OAuth inline flow — full path", () => {
  test("onAuthRequired fires, onAuthComplete fires, tool call retries after success", async () => {
    const authRequired: string[] = [];
    const authComplete: string[] = [];
    const oauthChannel: import("@koi/core").OAuthChannel = {
      onAuthRequired: (n) => {
        authRequired.push(n.provider);
      },
      onAuthComplete: (n) => {
        authComplete.push(n.provider);
      },
      submitAuthCode: () => {},
    };

    // let justified: track call count to verify retry
    let callCount = 0;
    const mockClient = {
      connect: mock(async (_transport: unknown) => {}),
      close: mock(async () => {}),
      listTools: mock(async () => ({ tools: [] as { name: string }[] })),
      callTool: mock(async (params: { name: string; arguments: Record<string, unknown> }) => {
        callCount++;
        if (callCount === 1) {
          throw new Error("401 Unauthorized");
        }
        if (params.name === "list_issues") {
          return { content: [{ type: "text", text: "issue-1" }] };
        }
        return {
          content: [{ type: "text", text: `Unknown tool: ${params.name}` }],
          isError: true,
        };
      }),
    };
    const mockTransport = createMockTransport();

    const onAuthNeeded = mock(async () => {
      oauthChannel.onAuthRequired({
        provider: "linear",
        message: "Authorize Linear",
        mode: "local",
      });
      oauthChannel.onAuthComplete({ provider: "linear" });
      return true;
    });

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded,
    });

    await conn.connect();
    const result = await conn.callTool("list_issues", {});

    expect(result.ok).toBe(true);
    expect(authRequired).toEqual(["linear"]);
    expect(authComplete).toEqual(["linear"]);
    expect(callCount).toBe(2);
  });
});

describe("auth-needed state machine — reconnect transition", () => {
  test("callTool — onAuthNeeded returns true → reconnects and retries (state machine allows auth-needed→connecting)", async () => {
    // Regression: after callTool receives 401 and onAuthNeeded returns true,
    // connect() is called to reconnect from auth-needed. This validates:
    //   1. State machine allows auth-needed→connecting transition
    //   2. Successful reconnect retries the original tool call
    let connectCallCount = 0;
    let callCount = 0;
    const mockClient = {
      connect: mock(async (_transport: unknown) => {
        connectCallCount++;
      }),
      close: mock(async () => {}),
      listTools: mock(async () => ({ tools: [] as { name: string }[] })),
      callTool: mock(async (_params: { name: string; arguments: Record<string, unknown> }) => {
        callCount++;
        if (callCount === 1) throw new Error("401 Unauthorized");
        return { content: [] };
      }),
    };
    const mockTransport = createMockTransport();

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded: mock(async () => true),
    });

    await conn.connect();
    // callTool → 401 → auth-needed → onAuthNeeded → connect() → retry
    const result = await conn.callTool("echo", {});

    // Connection successfully reconnected and retried from auth-needed state
    expect(result.ok).toBe(true);
    // connect was called twice: once at startup, once after onAuthNeeded returned true
    expect(connectCallCount).toBe(2);
  });

  test("onAuthNeeded rejection is caught — callTool returns AUTH_REQUIRED, does not throw", async () => {
    // onAuthNeeded runs during callTool 401. A rejection must be caught and
    // converted to `false` so the error stays within the Result boundary.
    const mockTransport = createMockTransport();

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => ({
        connect: mock(async (_transport: unknown) => {}),
        close: mock(async () => {}),
        listTools: mock(async () => ({ tools: [] as { name: string }[] })),
        callTool: mock(async () => {
          throw new Error("401 Unauthorized");
        }),
      })) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded: mock(async () => {
        throw new Error("channel send failed");
      }),
    });

    await conn.connect();
    const callResult = await conn.callTool("echo", {});
    expect(callResult.ok).toBe(false);
    if (!callResult.ok) {
      expect(callResult.error.code).toBe("AUTH_REQUIRED");
    }
  });
});

describe("callTool interactive auth after passive discovery 401", () => {
  test("callTool runs onAuthNeeded when connection is already in auth-needed from prior listTools 401", async () => {
    // Regression: listTools 401 → auth-needed (passive, no onAuthNeeded).
    // Subsequent callTool must detect auth-needed state and run onAuthNeeded
    // rather than letting ensureConnected() hit a plain connect() returning 401.
    let connectCallCount = 0;
    let listCallCount = 0;
    const mockClient = {
      connect: mock(async (_transport: unknown) => {
        connectCallCount++;
      }),
      close: mock(async () => {}),
      listTools: mock(async () => {
        listCallCount++;
        if (listCallCount === 1) throw new Error("401 Unauthorized");
        return { tools: [] as { name: string }[] };
      }),
      callTool: mock(async (_params: { name: string; arguments: Record<string, unknown> }) => {
        return { content: [{ type: "text", text: "ok" }] };
      }),
    };
    const mockTransport = createMockTransport();
    const onAuthNeeded = mock(async () => true);

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded,
    });

    await conn.connect();
    // listTools → 401 → auth-needed (passive, no onAuthNeeded)
    const listResult = await conn.listTools();
    expect(listResult.ok).toBe(false);
    expect(conn.state.kind).toBe("auth-needed");
    expect(onAuthNeeded).not.toHaveBeenCalled();

    // callTool should detect auth-needed, run onAuthNeeded, reconnect, then call
    const callResult = await conn.callTool("echo", {});
    expect(onAuthNeeded).toHaveBeenCalledTimes(1);
    expect(callResult.ok).toBe(true);
    expect(connectCallCount).toBe(2); // initial + reconnect after auth
  });

  test("callTool surfaces post-auth retry errors rather than original AUTH_REQUIRED", async () => {
    // Regression: after OAuth succeeds, if the retry callTool fails for a different
    // reason (server error, revoked scope, etc.), the actual error must be returned —
    // not the original AUTH_REQUIRED that triggered the auth flow.
    let callCount = 0;
    const mockClient = {
      connect: mock(async (_transport: unknown) => {}),
      close: mock(async () => {}),
      listTools: mock(async () => ({ tools: [] as { name: string }[] })),
      callTool: mock(async (_params: { name: string; arguments: Record<string, unknown> }) => {
        callCount++;
        if (callCount === 1) throw new Error("401 Unauthorized");
        throw new Error("503 Service Unavailable");
      }),
    };
    const mockTransport = createMockTransport();

    const conn = createMcpConnection(makeConfig(), undefined, {
      createClient: (() => mockClient) as ConnectionDeps["createClient"],
      createTransport: (() => mockTransport) as ConnectionDeps["createTransport"],
      onAuthNeeded: mock(async () => true),
    });

    await conn.connect();
    const result = await conn.callTool("echo", {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Must be the actual retry error, NOT AUTH_REQUIRED from the first call
      expect(result.error.code).not.toBe("AUTH_REQUIRED");
    }
  });
});

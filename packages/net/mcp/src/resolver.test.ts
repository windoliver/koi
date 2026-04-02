import { describe, expect, test } from "bun:test";
import { createMockConnection } from "./__tests__/mock-connection.js";
import { createMcpResolver } from "./resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestConnections() {
  return [
    createMockConnection(
      "filesystem",
      [
        { name: "read_file", description: "Reads a file", inputSchema: { type: "object" } },
        { name: "write_file", description: "Writes a file", inputSchema: { type: "object" } },
      ],
      { read_file: { ok: true, value: [{ type: "text", text: "content" }] } },
    ),
    createMockConnection(
      "github",
      [{ name: "create_pr", description: "Creates a PR", inputSchema: { type: "object" } }],
      { create_pr: { ok: true, value: [{ type: "text", text: "PR #1" }] } },
    ),
  ];
}

// ---------------------------------------------------------------------------
// construction validation
// ---------------------------------------------------------------------------

describe("createMcpResolver validation", () => {
  test("rejects server names containing the namespace separator", () => {
    const conn = createMockConnection("prod__github", []);
    expect(() => createMcpResolver([conn])).toThrow(/namespace separator/);
  });

  test("accepts server names with single underscore", () => {
    const conn = createMockConnection("my_server", []);
    expect(() => createMcpResolver([conn])).not.toThrow();
  });

  test("rejects duplicate server names", () => {
    const conn1 = createMockConnection("same-name", []);
    const conn2 = createMockConnection("same-name", []);
    expect(() => createMcpResolver([conn1, conn2])).toThrow(/Duplicate/);
  });

  test("accepts different server names", () => {
    const conn1 = createMockConnection("server-a", []);
    const conn2 = createMockConnection("server-b", []);
    expect(() => createMcpResolver([conn1, conn2])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// discover()
// ---------------------------------------------------------------------------

describe("createMcpResolver discover", () => {
  test("returns tools from all connections with namespaced names", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(3);
    expect(descriptors.map((d) => d.name)).toContain("filesystem__read_file");
    expect(descriptors.map((d) => d.name)).toContain("filesystem__write_file");
    expect(descriptors.map((d) => d.name)).toContain("github__create_pr");
  });

  test("returns empty array when no connections", async () => {
    const resolver = createMcpResolver([]);
    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(0);
  });

  test("sets server field on each descriptor", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    const descriptors = await resolver.discover();
    const fsTool = descriptors.find((d) => d.name === "filesystem__read_file");
    expect(fsTool?.server).toBe("filesystem");

    const ghTool = descriptors.find((d) => d.name === "github__create_pr");
    expect(ghTool?.server).toBe("github");
  });

  test("sets origin to operator for all descriptors", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    const descriptors = await resolver.discover();
    for (const d of descriptors) {
      expect(d.origin).toBe("operator");
    }
  });

  test("ignores connections that fail to list tools", async () => {
    const conns = [
      createMockConnection("healthy", [
        { name: "tool1", description: "test", inputSchema: { type: "object" } },
      ]),
      createMockConnection("broken", [], {}, { shouldFailListTools: true }),
    ];
    const resolver = createMcpResolver(conns);

    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.name).toBe("healthy__tool1");
  });

  test("records failures for servers that fail", async () => {
    const conns = [
      createMockConnection("healthy", [
        { name: "tool1", description: "test", inputSchema: { type: "object" } },
      ]),
      createMockConnection("broken", [], {}, { shouldFailListTools: true }),
    ];
    const resolver = createMcpResolver(conns);

    await resolver.discover();
    expect(resolver.failures).toHaveLength(1);
    expect(resolver.failures[0]?.serverName).toBe("broken");
  });

  test("lazily connects on first discover", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    // Before discover, no connect calls
    expect(conns[0]?.connectCallCount()).toBe(0);
    expect(conns[1]?.connectCallCount()).toBe(0);

    await resolver.discover();

    // After discover, both should have connected
    expect(conns[0]?.connectCallCount()).toBe(1);
    expect(conns[1]?.connectCallCount()).toBe(1);
  });

  test("does not reconnect already-connected servers", async () => {
    const conns = createTestConnections();
    // Pre-connect one
    await conns[0]?.connect();
    const resolver = createMcpResolver(conns);

    await resolver.discover();

    // filesystem was already connected — no additional connect call from resolver
    expect(conns[0]?.connectCallCount()).toBe(1);
    // github was idle — resolver connected it
    expect(conns[1]?.connectCallCount()).toBe(1);
  });

  test("records failures for servers that fail to connect", async () => {
    const conns = [
      createMockConnection("good", [
        { name: "t", description: "d", inputSchema: { type: "object" } },
      ]),
      createMockConnection("bad", [], {}, { shouldFailConnect: true }),
    ];
    const resolver = createMcpResolver(conns);

    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(1);
    expect(resolver.failures).toHaveLength(1);
    expect(resolver.failures[0]?.serverName).toBe("bad");
  });
});

// ---------------------------------------------------------------------------
// load()
// ---------------------------------------------------------------------------

describe("createMcpResolver load", () => {
  test("loads a tool by namespaced ID", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    const result = await resolver.load("filesystem__read_file");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("filesystem__read_file");
      expect(result.value.origin).toBe("operator");
      expect(result.value.policy.sandbox).toBe(false);
    }
  });

  test("returns NOT_FOUND for invalid ID format", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    const result = await resolver.load("invalid-id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("returns NOT_FOUND for unknown server", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    const result = await resolver.load("unknown__tool");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("unknown");
    }
  });

  test("returns NOT_FOUND for unknown tool on known server", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    const result = await resolver.load("filesystem__nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("nonexistent");
    }
  });

  test("execute delegates to connection callTool", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    const result = await resolver.load("filesystem__read_file");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const execResult = await result.value.execute({ path: "/test" });
      expect(execResult).toEqual([{ type: "text", text: "content" }]);
    }
  });

  test("uses cached tool list after discover", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    await resolver.discover();
    const initialCount = conns[0]?.listToolsCallCount() ?? 0;

    // Load should use cache, not re-fetch
    await resolver.load("filesystem__read_file");
    expect(conns[0]?.listToolsCallCount()).toBe(initialCount);
  });
});

// ---------------------------------------------------------------------------
// onChange (debounced push notifications)
// ---------------------------------------------------------------------------

describe("createMcpResolver onChange", () => {
  test("onChange returns an unsubscribe function", () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);
    const unsub = resolver.onChange?.(() => {});
    expect(typeof unsub).toBe("function");
  });

  test("listener fires when connection tools change (debounced)", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);
    let callCount = 0;
    resolver.onChange?.(() => {
      callCount++;
    });

    conns[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(1);
  });

  test("rapid tool changes are debounced into one callback", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);
    let callCount = 0;
    resolver.onChange?.(() => {
      callCount++;
    });

    for (let i = 0; i < 5; i++) {
      conns[0]?.simulateToolsChanged();
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(1);
  });

  test("unsubscribe prevents further notifications", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);
    let callCount = 0;
    const unsub = resolver.onChange?.(() => {
      callCount++;
    });

    unsub?.();
    conns[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(0);
  });

  test("multiple listeners are all notified", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);
    let count1 = 0;
    let count2 = 0;
    resolver.onChange?.(() => {
      count1++;
    });
    resolver.onChange?.(() => {
      count2++;
    });

    conns[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(count1).toBe(1);
    expect(count2).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-server cache invalidation
// ---------------------------------------------------------------------------

describe("createMcpResolver per-server cache", () => {
  test("onChange only invalidates the changed server's cache", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    // Populate caches for both servers
    await resolver.discover();
    const fsCount = conns[0]?.listToolsCallCount() ?? 0;
    const ghCount = conns[1]?.listToolsCallCount() ?? 0;

    // Trigger change on filesystem only
    conns[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Re-discover: should re-fetch filesystem but reuse github cache
    await resolver.discover();
    expect(conns[0]?.listToolsCallCount()).toBe(fsCount + 1);
    expect(conns[1]?.listToolsCallCount()).toBe(ghCount); // unchanged
  });

  test("clean server cache is reused on subsequent discover", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);

    await resolver.discover();
    const count = conns[0]?.listToolsCallCount() ?? 0;

    // Second discover without any changes — all cache hits
    await resolver.discover();
    expect(conns[0]?.listToolsCallCount()).toBe(count);
  });
});

// ---------------------------------------------------------------------------
// Dynamic discovery edge cases
// ---------------------------------------------------------------------------

describe("createMcpResolver dynamic discovery", () => {
  test("tool removal: removed tool no longer appears after re-discover", async () => {
    const conn = createMockConnection("srv", [
      { name: "a", description: "A", inputSchema: { type: "object" } },
      { name: "b", description: "B", inputSchema: { type: "object" } },
    ]);
    const resolver = createMcpResolver([conn]);

    const initial = await resolver.discover();
    expect(initial).toHaveLength(2);

    // Simulate server removing tool "b"
    conn.setTools([{ name: "a", description: "A", inputSchema: { type: "object" } }]);
    conn.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = await resolver.discover();
    expect(after).toHaveLength(1);
    expect(after[0]?.name).toBe("srv__a");
  });

  test("tool schema update: updated schema appears after re-discover", async () => {
    const conn = createMockConnection("srv", [
      { name: "t", description: "T", inputSchema: { type: "object" } },
    ]);
    const resolver = createMcpResolver([conn]);

    const initial = await resolver.discover();
    expect(initial[0]?.inputSchema).toEqual({ type: "object", properties: {} });

    // Simulate server updating tool schema
    conn.setTools([
      {
        name: "t",
        description: "T",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    conn.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = await resolver.discover();
    expect(after[0]?.inputSchema).toEqual({
      type: "object",
      properties: { q: { type: "string" } },
    });
  });

  test("tool addition: new tool appears after onChange + re-discover", async () => {
    const conn = createMockConnection("srv", [
      { name: "a", description: "A", inputSchema: { type: "object" } },
    ]);
    const resolver = createMcpResolver([conn]);

    const initial = await resolver.discover();
    expect(initial).toHaveLength(1);

    // Simulate server adding a new tool
    conn.setTools([
      { name: "a", description: "A", inputSchema: { type: "object" } },
      { name: "b", description: "B", inputSchema: { type: "object" } },
    ]);
    conn.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    const after = await resolver.discover();
    expect(after).toHaveLength(2);
    expect(after.map((d) => d.name)).toContain("srv__b");
  });

  test("server offline: connection failure during discover produces empty + failure", async () => {
    const conn = createMockConnection(
      "flaky",
      [{ name: "t", description: "T", inputSchema: { type: "object" } }],
      {},
      { shouldFailListTools: true },
    );
    // Pre-connect so discover doesn't hit the connect path
    await conn.connect();
    const resolver = createMcpResolver([conn]);

    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(0);
    expect(resolver.failures).toHaveLength(1);
    expect(resolver.failures[0]?.serverName).toBe("flaky");
  });

  test("concurrent discover: multiple callers get same result without duplicate connects", async () => {
    const conn = createMockConnection("srv", [
      { name: "a", description: "A", inputSchema: { type: "object" } },
    ]);
    const resolver = createMcpResolver([conn]);

    // Fire two concurrent discover() calls
    const [result1, result2] = await Promise.all([resolver.discover(), resolver.discover()]);

    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    expect(result1[0]?.name).toBe("srv__a");
    expect(result2[0]?.name).toBe("srv__a");
    // Memoization: only one connect + listTools per server
    expect(conn.connectCallCount()).toBe(1);
    expect(conn.listToolsCallCount()).toBe(1);
  });

  test("load() refreshes dirty cache after tools/list_changed (no discover needed)", async () => {
    const conn = createMockConnection(
      "srv",
      [
        { name: "a", description: "A", inputSchema: { type: "object" } },
        { name: "b", description: "B", inputSchema: { type: "object" } },
      ],
      {
        a: { ok: true, value: "result-a" },
      },
    );
    const resolver = createMcpResolver([conn]);

    // Populate cache
    await resolver.discover();
    const initialListCount = conn.listToolsCallCount();

    // Server removes tool "b"
    conn.setTools([{ name: "a", description: "A", inputSchema: { type: "object" } }]);
    conn.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    // load() should re-fetch (dirty cache) and find "a" but not "b"
    const loadA = await resolver.load("srv__a");
    expect(loadA.ok).toBe(true);
    expect(conn.listToolsCallCount()).toBe(initialListCount + 1); // re-fetched

    const loadB = await resolver.load("srv__b");
    expect(loadB.ok).toBe(false);
    if (!loadB.ok) {
      expect(loadB.error.code).toBe("NOT_FOUND");
    }
  });
});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

describe("createMcpResolver dispose", () => {
  test("dispose unsubscribes from connection notifications", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);
    let callCount = 0;
    resolver.onChange?.(() => {
      callCount++;
    });

    resolver.dispose();

    conns[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(0);
  });

  test("dispose clears change listeners", async () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);
    let callCount = 0;
    resolver.onChange?.(() => {
      callCount++;
    });

    resolver.dispose();
    conns[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(callCount).toBe(0);
  });

  test("dispose is idempotent", () => {
    const conns = createTestConnections();
    const resolver = createMcpResolver(conns);
    resolver.dispose();
    resolver.dispose(); // Should not throw
  });

  test("dispose clears failures", async () => {
    const conns = [createMockConnection("bad", [], {}, { shouldFailConnect: true })];
    const resolver = createMcpResolver(conns);
    await resolver.discover();
    expect(resolver.failures).toHaveLength(1);

    resolver.dispose();
    expect(resolver.failures).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Per-server discover timeout
// ---------------------------------------------------------------------------

describe("createMcpResolver per-server timeout", () => {
  test("hung server times out without blocking healthy servers", async () => {
    const healthy = createMockConnection("healthy", [
      { name: "t", description: "d", inputSchema: { type: "object" } },
    ]);
    // Simulate a server that takes 5 seconds to connect
    const hung = createMockConnection("hung", [], {}, { connectDelayMs: 5_000 });
    const resolver = createMcpResolver([healthy, hung], { discoverTimeoutMs: 200 });

    const start = Date.now();
    const descriptors = await resolver.discover();
    const elapsed = Date.now() - start;

    // Healthy server's tools should be returned
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.name).toBe("healthy__t");

    // Hung server should be in failures with TIMEOUT
    expect(resolver.failures).toHaveLength(1);
    expect(resolver.failures[0]?.serverName).toBe("hung");
    expect(resolver.failures[0]?.error.code).toBe("TIMEOUT");

    // Should complete in ~200ms, not 5s
    expect(elapsed).toBeLessThan(2_000);

    resolver.dispose();
  });
});

// ---------------------------------------------------------------------------
// Concurrent discover memoization
// ---------------------------------------------------------------------------

describe("createMcpResolver concurrent discover", () => {
  test("concurrent discover() calls share one connect per server", async () => {
    const conn = createMockConnection("srv", [
      { name: "a", description: "A", inputSchema: { type: "object" } },
    ]);
    const resolver = createMcpResolver([conn]);

    // Fire two concurrent discover() calls
    const [result1, result2] = await Promise.all([resolver.discover(), resolver.discover()]);

    expect(result1).toHaveLength(1);
    expect(result2).toHaveLength(1);
    // Only one connect should have happened (memoized)
    expect(conn.connectCallCount()).toBe(1);
    // Only one listTools call
    expect(conn.listToolsCallCount()).toBe(1);

    resolver.dispose();
  });
});

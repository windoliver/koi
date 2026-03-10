import { describe, expect, test } from "bun:test";
import { createMockMcpClientManager } from "./__tests__/mock-mcp-server.js";
import { createMcpResolver } from "./resolver.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestManagers(): ReturnType<typeof createMockMcpClientManager>[] {
  return [
    createMockMcpClientManager({
      name: "filesystem",
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
      callResults: {
        read_file: [{ type: "text", text: "content" }],
      },
    }),
    createMockMcpClientManager({
      name: "github",
      tools: [
        {
          name: "create_pr",
          description: "Creates a pull request",
          inputSchema: { type: "object" },
        },
      ],
      callResults: {
        create_pr: [{ type: "text", text: "PR #1" }],
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createMcpResolver", () => {
  test("discover returns tools from all managers", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(3);
    expect(descriptors.map((d) => d.name)).toContain("mcp/filesystem/read_file");
    expect(descriptors.map((d) => d.name)).toContain("mcp/filesystem/write_file");
    expect(descriptors.map((d) => d.name)).toContain("mcp/github/create_pr");
  });

  test("discover returns empty array when no managers", async () => {
    const resolver = createMcpResolver([]);
    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(0);
  });

  test("discover ignores managers that fail to list tools", async () => {
    const managers = [
      createMockMcpClientManager({
        name: "healthy",
        tools: [{ name: "tool1", description: "test", inputSchema: { type: "object" } }],
      }),
      createMockMcpClientManager({
        name: "broken",
        shouldFailListTools: true,
      }),
    ];
    const resolver = createMcpResolver(managers);

    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(1);
    expect(descriptors[0]?.name).toBe("mcp/healthy/tool1");
  });

  test("load resolves a valid tool ID", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    const result = await resolver.load("mcp/filesystem/read_file");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("mcp/filesystem/read_file");
      expect(result.value.policy.sandbox).toBe(false);
    }
  });

  test("load returns NOT_FOUND for invalid ID format", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    const result = await resolver.load("invalid-id");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  test("load returns NOT_FOUND for unknown server", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    const result = await resolver.load("mcp/unknown/tool");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("unknown");
    }
  });

  test("load returns NOT_FOUND for unknown tool on known server", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    const result = await resolver.load("mcp/filesystem/nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
      expect(result.error.message).toContain("nonexistent");
    }
  });

  test("loaded tool execute delegates to client", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    const result = await resolver.load("mcp/filesystem/read_file");
    expect(result.ok).toBe(true);
    if (result.ok) {
      const execResult = await result.value.execute({ path: "/test" });
      expect(execResult).toEqual([{ type: "text", text: "content" }]);
    }
  });

  test("load uses cached tool list after discover", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    // First discover populates cache
    await resolver.discover();

    // Second load should use cache (no extra listTools call needed)
    const result = await resolver.load("mcp/filesystem/read_file");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.descriptor.name).toBe("mcp/filesystem/read_file");
    }

    // Load from second server also cached
    const result2 = await resolver.load("mcp/github/create_pr");
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.value.descriptor.name).toBe("mcp/github/create_pr");
    }
  });

  test("source is not defined on MCP resolver", () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);
    expect(resolver.source).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// onChange (#73 — push-based discovery notifications)
// ---------------------------------------------------------------------------

describe("createMcpResolver onChange", () => {
  test("onChange is defined on MCP resolver", () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);
    expect(resolver.onChange).toBeDefined();
    expect(typeof resolver.onChange).toBe("function");
  });

  test("onChange returns an unsubscribe function", () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    const unsub = resolver.onChange?.(() => {});
    expect(typeof unsub).toBe("function");
  });

  test("listener fires when manager tools change (debounced)", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);
    let callCount = 0;

    resolver.onChange?.(() => {
      callCount++;
    });

    // Simulate a tool change from the first manager
    managers[0]?.simulateToolsChanged();

    // Wait for debounce (100ms default + buffer)
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(callCount).toBe(1);
  });

  test("rapid tool changes are debounced into one callback", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);
    let callCount = 0;

    resolver.onChange?.(() => {
      callCount++;
    });

    // Fire 5 rapid notifications
    for (let i = 0; i < 5; i++) {
      managers[0]?.simulateToolsChanged();
    }

    // Wait for debounce
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Should be debounced into 1 callback
    expect(callCount).toBe(1);
  });

  test("unsubscribe prevents further notifications", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);
    let callCount = 0;

    const unsub = resolver.onChange?.(() => {
      callCount++;
    });

    // Unsubscribe before any notification
    unsub?.();

    managers[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(callCount).toBe(0);
  });

  test("multiple listeners are all notified", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);
    let callCount1 = 0;
    let callCount2 = 0;

    resolver.onChange?.(() => {
      callCount1++;
    });
    resolver.onChange?.(() => {
      callCount2++;
    });

    managers[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(callCount1).toBe(1);
    expect(callCount2).toBe(1);
  });

  test("dispose unsubscribes from manager notifications", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);
    let callCount = 0;

    resolver.onChange?.(() => {
      callCount++;
    });

    // Dispose the resolver
    resolver.dispose();

    // Trigger a tool change — should NOT fire listener
    managers[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(callCount).toBe(0);
  });

  test("dispose clears all external change listeners", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);
    let callCount = 0;

    resolver.onChange?.(() => {
      callCount++;
    });

    // Dispose clears listeners — even if manager somehow fires, no listener runs
    resolver.dispose();

    // Re-subscribe a fresh manager listener manually won't help
    // because changeListeners was cleared
    managers[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(callCount).toBe(0);
  });

  test("dispose is idempotent", () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    // Should not throw when called multiple times
    resolver.dispose();
    resolver.dispose();
  });

  test("onChange invalidates tool cache so next discover re-fetches", async () => {
    const managers = createTestManagers();
    const resolver = createMcpResolver(managers);

    // Populate cache
    const initial = await resolver.discover();
    expect(initial).toHaveLength(3);

    // Wait for onChange to fire and invalidate cache
    let changed = false;
    resolver.onChange?.(() => {
      changed = true;
    });

    managers[0]?.simulateToolsChanged();
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(changed).toBe(true);

    // Next discover should re-fetch (cache was cleared)
    const after = await resolver.discover();
    expect(after).toHaveLength(3);
  });
});

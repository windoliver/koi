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
      expect(result.value.trustTier).toBe("promoted");
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

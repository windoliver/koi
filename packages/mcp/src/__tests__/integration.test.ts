import { describe, expect, test } from "bun:test";
import type { Tool } from "@koi/core";
import { toolToken } from "@koi/core";
import { createExecuteTool } from "../discover/execute-tool.js";
import { createSearchTool } from "../discover/search-tool.js";
import { createMcpResolver } from "../resolver.js";
import { mapMcpToolToKoi } from "../tool-adapter.js";
import { createMockMcpClientManager } from "./mock-mcp-server.js";

// ---------------------------------------------------------------------------
// Integration: tools mode
// ---------------------------------------------------------------------------

describe("integration: tools mode", () => {
  test("full lifecycle: create manager, list tools, wrap as Koi tools, attach to agent", async () => {
    const manager = createMockMcpClientManager({
      name: "filesystem",
      tools: [
        {
          name: "read_file",
          description: "Reads a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
        {
          name: "write_file",
          description: "Writes to a file",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" }, content: { type: "string" } },
            required: ["path", "content"],
          },
        },
      ],
      callResults: {
        read_file: [{ type: "text", text: "Hello, world!" }],
        write_file: [{ type: "text", text: "Written successfully" }],
      },
    });

    // Connect
    const connectResult = await manager.connect();
    expect(connectResult.ok).toBe(true);
    expect(manager.isConnected()).toBe(true);

    // List tools
    const listResult = await manager.listTools();
    expect(listResult.ok).toBe(true);
    if (!listResult.ok) return;

    expect(listResult.value).toHaveLength(2);

    // Wrap as Koi tools
    const tools = new Map<string, unknown>();
    for (const toolInfo of listResult.value) {
      const tool = mapMcpToolToKoi(toolInfo, manager, "filesystem");
      tools.set(toolToken(tool.descriptor.name) as string, tool);
    }

    expect(tools.size).toBe(2);
    expect(tools.has(toolToken("mcp/filesystem/read_file") as string)).toBe(true);
    expect(tools.has(toolToken("mcp/filesystem/write_file") as string)).toBe(true);

    // Execute a tool
    const readTool = tools.get(toolToken("mcp/filesystem/read_file") as string) as Tool;
    const readResult = await readTool.execute({ path: "/test.txt" });
    expect(readResult).toEqual([{ type: "text", text: "Hello, world!" }]);

    // Cleanup
    await manager.close();
    expect(manager.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: discover mode
// ---------------------------------------------------------------------------

describe("integration: discover mode", () => {
  test("creates search and execute meta-tools for discover mode", async () => {
    const manager = createMockMcpClientManager({
      name: "api-server",
      tools: [
        { name: "get_user", description: "Get user by ID", inputSchema: { type: "object" } },
        { name: "create_user", description: "Create a new user", inputSchema: { type: "object" } },
        {
          name: "delete_record",
          description: "Delete a database record",
          inputSchema: { type: "object" },
        },
      ],
      callResults: {
        get_user: [{ type: "text", text: '{"id":1,"name":"Alice"}' }],
      },
    });

    await manager.connect();

    const listResult = await manager.listTools();
    if (!listResult.ok) return;

    // Create discover mode tools
    const searchTool = createSearchTool("api-server", listResult.value);
    const executeTool = createExecuteTool("api-server", manager);

    // Search for user-related tools
    const searchResult = (await searchTool.execute({ query: "user" })) as {
      readonly total: number;
      readonly tools: readonly { readonly name: string }[];
    };

    expect(searchResult.total).toBe(2);
    expect(searchResult.tools.map((t) => t.name)).toContain("get_user");
    expect(searchResult.tools.map((t) => t.name)).toContain("create_user");

    // Execute a discovered tool
    const execResult = await executeTool.execute({
      tool: "get_user",
      args: { id: 1 },
    });

    expect(execResult).toEqual([{ type: "text", text: '{"id":1,"name":"Alice"}' }]);

    await manager.close();
  });
});

// ---------------------------------------------------------------------------
// Integration: resolver
// ---------------------------------------------------------------------------

describe("integration: resolver", () => {
  test("resolver discovers and loads tools across multiple servers", async () => {
    const managers = [
      createMockMcpClientManager({
        name: "fs",
        tools: [{ name: "read", description: "Read file", inputSchema: { type: "object" } }],
        callResults: { read: "file content" },
      }),
      createMockMcpClientManager({
        name: "git",
        tools: [{ name: "commit", description: "Git commit", inputSchema: { type: "object" } }],
        callResults: { commit: "committed" },
      }),
    ];

    const resolver = createMcpResolver(managers);

    // Discover
    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(2);

    // Load
    const readResult = await resolver.load("mcp/fs/read");
    expect(readResult.ok).toBe(true);
    if (readResult.ok) {
      expect(readResult.value.descriptor.name).toBe("mcp/fs/read");
      const execResult = await readResult.value.execute({});
      expect(execResult).toBe("file content");
    }

    // Load from second server
    const commitResult = await resolver.load("mcp/git/commit");
    expect(commitResult.ok).toBe(true);
    if (commitResult.ok) {
      expect(commitResult.value.descriptor.name).toBe("mcp/git/commit");
    }

    // Unknown tool
    const missing = await resolver.load("mcp/fs/missing");
    expect(missing.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Integration: failure handling
// ---------------------------------------------------------------------------

describe("integration: failure handling", () => {
  test("handles partial server failures gracefully", async () => {
    const healthy = createMockMcpClientManager({
      name: "healthy",
      tools: [{ name: "ping", description: "Ping", inputSchema: { type: "object" } }],
      callResults: { ping: "pong" },
    });

    const broken = createMockMcpClientManager({
      name: "broken",
      shouldFailConnect: true,
    });

    // Healthy server works
    const connectResult = await healthy.connect();
    expect(connectResult.ok).toBe(true);

    // Broken server fails
    const brokenResult = await broken.connect();
    expect(brokenResult.ok).toBe(false);

    // Resolver still works with healthy servers only
    const resolver = createMcpResolver([healthy]);
    const descriptors = await resolver.discover();
    expect(descriptors).toHaveLength(1);

    await healthy.close();
  });
});

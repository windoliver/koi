import { describe, expect, test } from "bun:test";
import { createMockMcpClientManager } from "./__tests__/mock-mcp-server.js";
import type { McpToolInfo } from "./client-manager.js";
import { mcpToolToKoiTool } from "./tool-adapter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestToolInfo(): McpToolInfo {
  return {
    name: "read_file",
    description: "Reads a file from the filesystem",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path" },
      },
      required: ["path"],
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("mcpToolToKoiTool", () => {
  test("creates tool with namespaced name", () => {
    const toolInfo = createTestToolInfo();
    const client = createMockMcpClientManager({ name: "filesystem" });
    const tool = mcpToolToKoiTool(toolInfo, client, "filesystem");

    expect(tool.descriptor.name).toBe("mcp/filesystem/read_file");
  });

  test("preserves description and inputSchema", () => {
    const toolInfo = createTestToolInfo();
    const client = createMockMcpClientManager({ name: "filesystem" });
    const tool = mcpToolToKoiTool(toolInfo, client, "filesystem");

    expect(tool.descriptor.description).toBe("Reads a file from the filesystem");
    expect(tool.descriptor.inputSchema).toEqual(toolInfo.inputSchema);
  });

  test("sets trust tier to promoted", () => {
    const toolInfo = createTestToolInfo();
    const client = createMockMcpClientManager({ name: "filesystem" });
    const tool = mcpToolToKoiTool(toolInfo, client, "filesystem");

    expect(tool.trustTier).toBe("promoted");
  });

  test("execute delegates to client.callTool with original tool name", async () => {
    const toolInfo = createTestToolInfo();
    const client = createMockMcpClientManager({
      name: "filesystem",
      callResults: {
        read_file: [{ type: "text", text: "file contents" }],
      },
    });
    const tool = mcpToolToKoiTool(toolInfo, client, "filesystem");

    const result = await tool.execute({ path: "/test.txt" });
    expect(result).toEqual([{ type: "text", text: "file contents" }]);
  });

  test("execute returns error result when callTool fails", async () => {
    const toolInfo = createTestToolInfo();
    const client = createMockMcpClientManager({
      name: "filesystem",
      callResults: {},
    });
    const tool = mcpToolToKoiTool(toolInfo, client, "filesystem");

    const result = await tool.execute({ path: "/missing.txt" });
    expect(result).toHaveProperty("ok", false);
  });

  test("handles different server names in namespace", () => {
    const toolInfo = createTestToolInfo();
    const client1 = createMockMcpClientManager({ name: "server-a" });
    const client2 = createMockMcpClientManager({ name: "server-b" });

    const tool1 = mcpToolToKoiTool(toolInfo, client1, "server-a");
    const tool2 = mcpToolToKoiTool(toolInfo, client2, "server-b");

    expect(tool1.descriptor.name).toBe("mcp/server-a/read_file");
    expect(tool2.descriptor.name).toBe("mcp/server-b/read_file");
  });

  test("execute function is async", () => {
    const toolInfo = createTestToolInfo();
    const client = createMockMcpClientManager({ name: "test" });
    const tool = mcpToolToKoiTool(toolInfo, client, "test");

    const result = tool.execute({});
    expect(result).toBeInstanceOf(Promise);
  });
});

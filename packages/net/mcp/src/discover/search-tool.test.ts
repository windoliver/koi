import { describe, expect, test } from "bun:test";
import type { McpToolInfo } from "../client-manager.js";
import { createSearchTool } from "./search-tool.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestTools(): readonly McpToolInfo[] {
  return [
    {
      name: "read_file",
      description: "Reads a file from the filesystem",
      inputSchema: { type: "object" },
    },
    {
      name: "write_file",
      description: "Writes content to a file",
      inputSchema: { type: "object" },
    },
    {
      name: "list_directory",
      description: "Lists files in a directory",
      inputSchema: { type: "object" },
    },
    {
      name: "search_code",
      description: "Searches code using regex patterns",
      inputSchema: { type: "object" },
    },
  ] as const;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createSearchTool", () => {
  test("creates tool with correct namespaced name", () => {
    const tool = createSearchTool("filesystem", []);
    expect(tool.descriptor.name).toBe("mcp/filesystem/mcp_search");
  });

  test("has promoted trust tier", () => {
    const tool = createSearchTool("filesystem", []);
    expect(tool.policy.sandbox).toBe(false);
  });

  test("returns all tools when no query specified", async () => {
    const tools = createTestTools();
    const searchTool = createSearchTool("filesystem", tools);

    const result = (await searchTool.execute({})) as {
      readonly total: number;
      readonly returned: number;
      readonly tools: readonly { readonly name: string }[];
    };

    expect(result.total).toBe(4);
    expect(result.returned).toBe(4);
    expect(result.tools).toHaveLength(4);
  });

  test("filters tools by name query (case-insensitive)", async () => {
    const tools = createTestTools();
    const searchTool = createSearchTool("filesystem", tools);

    const result = (await searchTool.execute({ query: "FILE" })) as {
      readonly total: number;
      readonly tools: readonly { readonly name: string }[];
    };

    expect(result.total).toBe(3);
    expect(result.tools.map((t) => t.name)).toContain("read_file");
    expect(result.tools.map((t) => t.name)).toContain("write_file");
    expect(result.tools.map((t) => t.name)).toContain("list_directory");
  });

  test("filters tools by description query", async () => {
    const tools = createTestTools();
    const searchTool = createSearchTool("filesystem", tools);

    const result = (await searchTool.execute({ query: "regex" })) as {
      readonly total: number;
      readonly tools: readonly { readonly name: string }[];
    };

    expect(result.total).toBe(1);
    expect(result.tools[0]?.name).toBe("search_code");
  });

  test("returns empty for non-matching query", async () => {
    const tools = createTestTools();
    const searchTool = createSearchTool("filesystem", tools);

    const result = (await searchTool.execute({ query: "nonexistent_xyz" })) as {
      readonly total: number;
      readonly tools: readonly unknown[];
    };

    expect(result.total).toBe(0);
    expect(result.tools).toHaveLength(0);
  });

  test("respects limit parameter", async () => {
    const tools = createTestTools();
    const searchTool = createSearchTool("filesystem", tools);

    const result = (await searchTool.execute({ limit: 2 })) as {
      readonly total: number;
      readonly returned: number;
      readonly tools: readonly unknown[];
    };

    expect(result.total).toBe(4);
    expect(result.returned).toBe(2);
    expect(result.tools).toHaveLength(2);
  });

  test("includes inputSchema in results", async () => {
    const tools = createTestTools();
    const searchTool = createSearchTool("filesystem", tools);

    const result = (await searchTool.execute({ query: "read_file" })) as {
      readonly tools: readonly { readonly inputSchema: unknown }[];
    };

    expect(result.tools[0]?.inputSchema).toEqual({ type: "object" });
  });

  test("handles empty query string same as no query", async () => {
    const tools = createTestTools();
    const searchTool = createSearchTool("filesystem", tools);

    const result = (await searchTool.execute({ query: "" })) as {
      readonly total: number;
    };

    expect(result.total).toBe(4);
  });
});

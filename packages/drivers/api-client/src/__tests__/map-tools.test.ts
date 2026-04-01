import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import { toAnthropicTools } from "../map-tools.js";

describe("toAnthropicTools", () => {
  test("maps a single tool descriptor", () => {
    const tools: readonly ToolDescriptor[] = [
      {
        name: "read_file",
        description: "Read a file from disk",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ];

    const result = toAnthropicTools(tools);
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("read_file");
    expect(result[0]?.description).toBe("Read a file from disk");
    expect(result[0]?.input_schema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    });
  });

  test("maps multiple tool descriptors", () => {
    const tools: readonly ToolDescriptor[] = [
      { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      { name: "tool_b", description: "B", inputSchema: { type: "object" } },
    ];

    const result = toAnthropicTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0]?.name).toBe("tool_a");
    expect(result[1]?.name).toBe("tool_b");
  });

  test("returns empty array for empty input", () => {
    expect(toAnthropicTools([])).toEqual([]);
  });
});

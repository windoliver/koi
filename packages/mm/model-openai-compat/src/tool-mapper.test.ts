/**
 * Tool mapper tests — Koi ToolDescriptor → OpenAI Chat Completions tool format.
 */

import { describe, expect, test } from "bun:test";
import type { ToolDescriptor } from "@koi/core";
import { mapToolDescriptors } from "./tool-mapper.js";
import type { ResolvedCompat } from "./types.js";
import { resolveCompat } from "./types.js";

const DEFAULT_COMPAT: ResolvedCompat = resolveCompat("https://openrouter.ai/api/v1");

describe("mapToolDescriptors", () => {
  test("maps a single tool descriptor", () => {
    const tools: readonly ToolDescriptor[] = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        inputSchema: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      },
    ];

    const result = mapToolDescriptors(tools, DEFAULT_COMPAT);

    expect(result).toHaveLength(1);
    expect(result[0]?.type).toBe("function");
    expect(result[0]?.function.name).toBe("get_weather");
    expect(result[0]?.function.description).toBe("Get weather for a city");
    expect(result[0]?.function.parameters).toEqual({
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    });
  });

  test("maps multiple tool descriptors", () => {
    const tools: readonly ToolDescriptor[] = [
      { name: "tool_a", description: "A", inputSchema: { type: "object" } },
      { name: "tool_b", description: "B", inputSchema: { type: "object" } },
    ];

    const result = mapToolDescriptors(tools, DEFAULT_COMPAT);
    expect(result).toHaveLength(2);
    expect(result[0]?.function.name).toBe("tool_a");
    expect(result[1]?.function.name).toBe("tool_b");
  });

  test("returns empty array for empty input", () => {
    expect(mapToolDescriptors([], DEFAULT_COMPAT)).toHaveLength(0);
  });

  test("includes strict: false when compat.supportsStrictMode is true", () => {
    const tools: readonly ToolDescriptor[] = [
      { name: "fn", description: "d", inputSchema: { type: "object" } },
    ];
    const compat = resolveCompat("https://openrouter.ai/api/v1");
    const result = mapToolDescriptors(tools, compat);
    expect(result[0]?.function.strict).toBe(false);
  });

  test("omits strict when compat.supportsStrictMode is false", () => {
    const tools: readonly ToolDescriptor[] = [
      { name: "fn", description: "d", inputSchema: { type: "object" } },
    ];
    const compat = resolveCompat("https://openrouter.ai/api/v1", {
      supportsStrictMode: false,
    });
    const result = mapToolDescriptors(tools, compat);
    expect(result[0]?.function).not.toHaveProperty("strict");
  });
});

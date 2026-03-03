import { describe, expect, test } from "bun:test";
import type { ToolCallPattern } from "../types.js";
import { BUILTIN_PATTERNS, resolvePatterns } from "./registry.js";

describe("BUILTIN_PATTERNS", () => {
  test("contains all three built-in patterns", () => {
    expect(BUILTIN_PATTERNS.has("hermes")).toBe(true);
    expect(BUILTIN_PATTERNS.has("llama31")).toBe(true);
    expect(BUILTIN_PATTERNS.has("json-fence")).toBe(true);
    expect(BUILTIN_PATTERNS.size).toBe(3);
  });
});

describe("resolvePatterns", () => {
  test("resolves built-in pattern names", () => {
    const patterns = resolvePatterns(["hermes", "llama31"]);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]?.name).toBe("hermes");
    expect(patterns[1]?.name).toBe("llama31");
  });

  test("passes through custom ToolCallPattern objects", () => {
    const custom: ToolCallPattern = { name: "custom", detect: () => undefined };
    const patterns = resolvePatterns([custom]);
    expect(patterns).toHaveLength(1);
    expect(patterns[0]).toBe(custom);
  });

  test("handles mixed string and custom patterns", () => {
    const custom: ToolCallPattern = { name: "custom", detect: () => undefined };
    const patterns = resolvePatterns(["hermes", custom, "llama31"]);
    expect(patterns).toHaveLength(3);
    expect(patterns[0]?.name).toBe("hermes");
    expect(patterns[1]).toBe(custom);
    expect(patterns[2]?.name).toBe("llama31");
  });

  test("throws on unknown pattern name", () => {
    expect(() => resolvePatterns(["unknown"])).toThrow("Unknown tool recovery pattern");
  });

  test("returns empty array for empty input", () => {
    const patterns = resolvePatterns([]);
    expect(patterns).toHaveLength(0);
  });
});

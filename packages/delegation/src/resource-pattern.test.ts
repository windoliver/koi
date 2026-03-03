import { describe, expect, test } from "bun:test";
import { parseResourcePattern } from "./resource-pattern.js";

describe("parseResourcePattern", () => {
  test("parses tool:path pattern", () => {
    const result = parseResourcePattern("read_file:/workspace/src/main.ts");
    expect(result).toEqual({ tool: "read_file", path: "/workspace/src/main.ts" });
  });

  test("returns undefined for pattern with no colon", () => {
    expect(parseResourcePattern("read_file")).toBeUndefined();
  });

  test("handles multiple colons — splits on first only", () => {
    const result = parseResourcePattern("read_file:/path:with:colons");
    expect(result).toEqual({ tool: "read_file", path: "/path:with:colons" });
  });

  test("handles empty tool segment (colon at start)", () => {
    const result = parseResourcePattern(":/some/path");
    expect(result).toEqual({ tool: "", path: "/some/path" });
  });

  test("handles empty path segment (colon at end)", () => {
    const result = parseResourcePattern("read_file:");
    expect(result).toEqual({ tool: "read_file", path: "" });
  });

  test("handles empty string", () => {
    expect(parseResourcePattern("")).toBeUndefined();
  });

  test("handles glob resource patterns", () => {
    const result = parseResourcePattern("write_file:/workspace/src/**");
    expect(result).toEqual({ tool: "write_file", path: "/workspace/src/**" });
  });
});

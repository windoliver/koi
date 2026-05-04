import { describe, expect, test } from "bun:test";
import { metaPath, nodePath, validateSegment } from "./paths.js";

describe("nodePath", () => {
  test("composes basePath/chainId/nodeId.json", () => {
    expect(nodePath("snapshots", "chain-1", "node-abc")).toBe("snapshots/chain-1/node-abc.json");
  });
});

describe("metaPath", () => {
  test("composes basePath/chainId/meta.json", () => {
    expect(metaPath("snapshots", "chain-1")).toBe("snapshots/chain-1/meta.json");
  });
});

describe("validateSegment", () => {
  test("accepts safe segments", () => {
    const r = validateSegment("chain-1", "Chain ID");
    expect(r.ok).toBe(true);
  });

  test.each([
    ["", "empty"],
    ["a/b", "slash"],
    ["..", "dotdot"],
    ["a\\b", "backslash"],
    ["a\0b", "null byte"],
  ])("rejects unsafe segment: %s (%s)", (segment) => {
    const r = validateSegment(segment, "Test");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });
});

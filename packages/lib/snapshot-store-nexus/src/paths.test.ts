import { describe, expect, test } from "bun:test";
import { canonicalNodePath, memberGlob, memberPath, metaPath, validateSegment } from "./paths.js";

describe("canonicalNodePath", () => {
  test("composes basePath/_nodes/nodeId.json", () => {
    expect(canonicalNodePath("snapshots", "node-abc")).toBe("snapshots/_nodes/node-abc.json");
  });
});

describe("memberPath", () => {
  test("composes basePath/chainId/members/nodeId.member", () => {
    expect(memberPath("snapshots", "chain-1", "node-abc")).toBe(
      "snapshots/chain-1/members/node-abc.member",
    );
  });
});

describe("memberGlob", () => {
  test("composes basePath/chainId/members/*.member", () => {
    expect(memberGlob("snapshots", "chain-1")).toBe("snapshots/chain-1/members/*.member");
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

  // --- Fix 4 (round 5): _nodes reserved namespace ---

  test("rejects reserved chain ID '_nodes'", () => {
    const r = validateSegment("_nodes", "Chain ID");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("VALIDATION");
  });

  test("accepts '_NODES' (case-sensitive — only the lowercase form is reserved)", () => {
    const r = validateSegment("_NODES", "Chain ID");
    expect(r.ok).toBe(true);
  });
});

import { describe, expect, it } from "bun:test";
import { computeMergeLevels, computeMergeOrder } from "./merge-order.js";
import type { MergeBranch } from "./types.js";

describe("computeMergeOrder", () => {
  it("returns empty array for empty input", () => {
    const result = computeMergeOrder([]);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("handles single branch with no deps", () => {
    const result = computeMergeOrder([{ name: "a", dependsOn: [] }]);
    expect(result).toEqual({ ok: true, value: ["a"] });
  });

  it("orders two independent branches alphabetically", () => {
    const branches: readonly MergeBranch[] = [
      { name: "b", dependsOn: [] },
      { name: "a", dependsOn: [] },
    ];
    const result = computeMergeOrder(branches);
    expect(result).toEqual({ ok: true, value: ["a", "b"] });
  });

  it("orders chain: c depends on b depends on a", () => {
    const branches: readonly MergeBranch[] = [
      { name: "c", dependsOn: ["b"] },
      { name: "a", dependsOn: [] },
      { name: "b", dependsOn: ["a"] },
    ];
    const result = computeMergeOrder(branches);
    expect(result).toEqual({ ok: true, value: ["a", "b", "c"] });
  });

  it("orders diamond dependency: d depends on b,c; b,c depend on a", () => {
    const branches: readonly MergeBranch[] = [
      { name: "d", dependsOn: ["b", "c"] },
      { name: "b", dependsOn: ["a"] },
      { name: "c", dependsOn: ["a"] },
      { name: "a", dependsOn: [] },
    ];
    const result = computeMergeOrder(branches);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0]).toBe("a");
      expect(result.value.indexOf("b")).toBeLessThan(result.value.indexOf("d"));
      expect(result.value.indexOf("c")).toBeLessThan(result.value.indexOf("d"));
    }
  });

  it("detects cycle: a -> b -> a", () => {
    const branches: readonly MergeBranch[] = [
      { name: "a", dependsOn: ["b"] },
      { name: "b", dependsOn: ["a"] },
    ];
    const result = computeMergeOrder(branches);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
      expect(result.error.message).toContain("Cycle");
    }
  });

  it("detects 3-node cycle: a -> b -> c -> a", () => {
    const branches: readonly MergeBranch[] = [
      { name: "a", dependsOn: ["c"] },
      { name: "b", dependsOn: ["a"] },
      { name: "c", dependsOn: ["b"] },
    ];
    const result = computeMergeOrder(branches);
    expect(result.ok).toBe(false);
  });
});

describe("computeMergeLevels", () => {
  it("returns empty array for empty input", () => {
    const result = computeMergeLevels([]);
    expect(result).toEqual({ ok: true, value: [] });
  });

  it("places independent branches in same level", () => {
    const branches: readonly MergeBranch[] = [
      { name: "a", dependsOn: [] },
      { name: "b", dependsOn: [] },
      { name: "c", dependsOn: [] },
    ];
    const result = computeMergeLevels(branches);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0]).toEqual(["a", "b", "c"]);
    }
  });

  it("separates chain into levels", () => {
    const branches: readonly MergeBranch[] = [
      { name: "c", dependsOn: ["b"] },
      { name: "a", dependsOn: [] },
      { name: "b", dependsOn: ["a"] },
    ];
    const result = computeMergeLevels(branches);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([["a"], ["b"], ["c"]]);
    }
  });

  it("handles diamond dependency with correct levels", () => {
    const branches: readonly MergeBranch[] = [
      { name: "d", dependsOn: ["b", "c"] },
      { name: "b", dependsOn: ["a"] },
      { name: "c", dependsOn: ["a"] },
      { name: "a", dependsOn: [] },
    ];
    const result = computeMergeLevels(branches);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([["a"], ["b", "c"], ["d"]]);
    }
  });

  it("detects cycle", () => {
    const branches: readonly MergeBranch[] = [
      { name: "a", dependsOn: ["b"] },
      { name: "b", dependsOn: ["a"] },
    ];
    const result = computeMergeLevels(branches);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });
});

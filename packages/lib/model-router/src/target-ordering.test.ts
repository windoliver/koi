import { describe, expect, test } from "bun:test";
import type { FallbackTarget } from "./fallback.js";
import { createTargetOrderer } from "./target-ordering.js";

function makeTargets(...ids: string[]): readonly FallbackTarget[] {
  return ids.map((id) => ({ id, enabled: true }));
}

describe("createTargetOrderer — fallback", () => {
  test("returns targets in original order (identity)", () => {
    const orderer = createTargetOrderer({ strategy: "fallback" });
    const targets = makeTargets("a", "b", "c");
    expect(orderer(targets).map((t) => t.id)).toEqual(["a", "b", "c"]);
  });

  test("single target → same target returned", () => {
    const orderer = createTargetOrderer({ strategy: "fallback" });
    const result = orderer(makeTargets("only"));
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("only");
  });
});

describe("createTargetOrderer — round-robin", () => {
  test("rotates primary on successive calls", () => {
    const orderer = createTargetOrderer({ strategy: "round-robin" });
    const targets = makeTargets("a", "b", "c");

    const first = orderer(targets).map((t) => t.id);
    const second = orderer(targets).map((t) => t.id);
    const third = orderer(targets).map((t) => t.id);

    expect(first[0]).toBe("a");
    expect(second[0]).toBe("b");
    expect(third[0]).toBe("c");
  });

  test("wraps around after all targets served", () => {
    const orderer = createTargetOrderer({ strategy: "round-robin" });
    const targets = makeTargets("a", "b");

    orderer(targets); // a first
    orderer(targets); // b first
    const third = orderer(targets); // wraps → a first again
    expect(third[0]?.id).toBe("a");
  });

  test("single target always returns that target first", () => {
    const orderer = createTargetOrderer({ strategy: "round-robin" });
    const targets = makeTargets("solo");
    expect(orderer(targets)[0]?.id).toBe("solo");
    expect(orderer(targets)[0]?.id).toBe("solo");
  });

  test("preserves all targets in rotation result", () => {
    const orderer = createTargetOrderer({ strategy: "round-robin" });
    const targets = makeTargets("a", "b", "c");
    const result = orderer(targets);
    expect(result).toHaveLength(3);
    expect(result.map((t) => t.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("createTargetOrderer — weighted", () => {
  test("selects highest-weight target most often", () => {
    const weights = new Map([
      ["a", 0.9],
      ["b", 0.1],
    ]);
    // Use seeded deterministic random (0.0 → always "a" given weight 0.9)
    let randVal = 0;
    const orderer = createTargetOrderer({
      strategy: "weighted",
      weights,
      random: () => randVal,
    });

    // roll = 0 → cumulative: a=0.9 → 0 < 0.9 → primary is a
    randVal = 0;
    const r1 = orderer(makeTargets("a", "b"));
    expect(r1[0]?.id).toBe("a");

    // roll = 0.95 → cumulative: a=0.9 (miss), b=1.0 → primary is b
    randVal = 0.95;
    const r2 = orderer(makeTargets("a", "b"));
    expect(r2[0]?.id).toBe("b");
  });

  test("remaining targets sorted by descending weight", () => {
    const weights = new Map([
      ["a", 0.8],
      ["b", 0.6],
      ["c", 0.4],
    ]);
    // Force a as primary (roll = 0)
    const orderer = createTargetOrderer({
      strategy: "weighted",
      weights,
      random: () => 0,
    });
    const result = orderer(makeTargets("a", "b", "c"));
    expect(result[0]?.id).toBe("a");
    expect(result[1]?.id).toBe("b"); // 0.6 > 0.4
    expect(result[2]?.id).toBe("c");
  });

  test("all-zero weights falls back to original order", () => {
    const weights = new Map([
      ["a", 0],
      ["b", 0],
    ]);
    const orderer = createTargetOrderer({ strategy: "weighted", weights });
    const result = orderer(makeTargets("a", "b"));
    expect(result.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("missing weights default to 1", () => {
    // No weights provided — all targets get weight 1 → uniform
    const orderer = createTargetOrderer({
      strategy: "weighted",
      random: () => 0, // always picks first target (index 0)
    });
    const result = orderer(makeTargets("a", "b", "c"));
    expect(result[0]?.id).toBe("a");
  });
});

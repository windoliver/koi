import { describe, expect, test } from "bun:test";
import type { FallbackTarget } from "./fallback.js";
import { createTargetOrderer } from "./target-ordering.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTargets(...ids: readonly string[]): readonly FallbackTarget[] {
  return ids.map((id) => ({ id, enabled: true }));
}

// ---------------------------------------------------------------------------
// fallback / cascade — identity
// ---------------------------------------------------------------------------

describe("fallback strategy", () => {
  test("returns targets in declared order", () => {
    const orderer = createTargetOrderer({ strategy: "fallback" });
    const targets = makeTargets("a", "b", "c");
    expect(orderer(targets)).toEqual(targets);
  });
});

describe("cascade strategy", () => {
  test("returns targets in declared order", () => {
    const orderer = createTargetOrderer({ strategy: "cascade" });
    const targets = makeTargets("a", "b", "c");
    expect(orderer(targets)).toEqual(targets);
  });
});

// ---------------------------------------------------------------------------
// round-robin
// ---------------------------------------------------------------------------

describe("round-robin strategy", () => {
  test("rotates primary target on each call", () => {
    const orderer = createTargetOrderer({ strategy: "round-robin" });
    const targets = makeTargets("a", "b", "c");

    const call1 = orderer(targets);
    expect(call1[0]?.id).toBe("a");
    expect(call1[1]?.id).toBe("b");
    expect(call1[2]?.id).toBe("c");

    const call2 = orderer(targets);
    expect(call2[0]?.id).toBe("b");
    expect(call2[1]?.id).toBe("c");
    expect(call2[2]?.id).toBe("a");

    const call3 = orderer(targets);
    expect(call3[0]?.id).toBe("c");
    expect(call3[1]?.id).toBe("a");
    expect(call3[2]?.id).toBe("b");
  });

  test("wraps around after cycling through all targets", () => {
    const orderer = createTargetOrderer({ strategy: "round-robin" });
    const targets = makeTargets("a", "b");

    // Call 0 → a first, call 1 → b first, call 2 → a first again
    orderer(targets);
    orderer(targets);
    const call3 = orderer(targets);
    expect(call3[0]?.id).toBe("a");
    expect(call3[1]?.id).toBe("b");
  });

  test("returns single-target array unchanged", () => {
    const orderer = createTargetOrderer({ strategy: "round-robin" });
    const targets = makeTargets("a");

    const result = orderer(targets);
    expect(result).toEqual(targets);
  });

  test("returns empty array unchanged", () => {
    const orderer = createTargetOrderer({ strategy: "round-robin" });
    expect(orderer([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// weighted
// ---------------------------------------------------------------------------

describe("weighted strategy", () => {
  test("selects primary based on weighted random", () => {
    const weights = new Map([
      ["a", 0.2],
      ["b", 0.8],
    ]);
    // random() = 0.1 → roll = 0.1 * 1.0 = 0.1 → falls in a's range [0, 0.2)
    const orderer = createTargetOrderer({
      strategy: "weighted",
      weights,
      random: () => 0.1,
    });
    const targets = makeTargets("a", "b");

    const result = orderer(targets);
    expect(result[0]?.id).toBe("a");
    expect(result[1]?.id).toBe("b");
  });

  test("selects higher-weight target when random falls in its range", () => {
    const weights = new Map([
      ["a", 0.2],
      ["b", 0.8],
    ]);
    // random() = 0.5 → roll = 0.5 * 1.0 = 0.5 → a range [0, 0.2), b range [0.2, 1.0) → b
    const orderer = createTargetOrderer({
      strategy: "weighted",
      weights,
      random: () => 0.5,
    });
    const targets = makeTargets("a", "b");

    const result = orderer(targets);
    expect(result[0]?.id).toBe("b");
    expect(result[1]?.id).toBe("a");
  });

  test("remaining targets sorted by descending weight", () => {
    const weights = new Map([
      ["a", 0.1],
      ["b", 0.5],
      ["c", 0.3],
    ]);
    // random() = 0.0 → selects "a" (first cumulative bucket)
    const orderer = createTargetOrderer({
      strategy: "weighted",
      weights,
      random: () => 0.0,
    });
    const targets = makeTargets("a", "b", "c");

    const result = orderer(targets);
    expect(result[0]?.id).toBe("a"); // primary
    expect(result[1]?.id).toBe("b"); // weight 0.5 (highest remaining)
    expect(result[2]?.id).toBe("c"); // weight 0.3
  });

  test("all-zero-weights gracefully degrades to declared order", () => {
    const weights = new Map([
      ["a", 0],
      ["b", 0],
    ]);
    const orderer = createTargetOrderer({
      strategy: "weighted",
      weights,
      random: () => 0.5,
    });
    const targets = makeTargets("a", "b");

    const result = orderer(targets);
    expect(result).toEqual(targets);
  });

  test("missing weights default to 1", () => {
    // No weights provided → all default to 1 → uniform distribution
    // random() = 0.0 → selects first target
    const orderer = createTargetOrderer({
      strategy: "weighted",
      random: () => 0.0,
    });
    const targets = makeTargets("a", "b", "c");

    const result = orderer(targets);
    expect(result[0]?.id).toBe("a");
  });

  test("returns single-target array unchanged", () => {
    const orderer = createTargetOrderer({
      strategy: "weighted",
      weights: new Map([["a", 0.5]]),
      random: () => 0.5,
    });
    const targets = makeTargets("a");

    expect(orderer(targets)).toEqual(targets);
  });

  test("returns empty array unchanged", () => {
    const orderer = createTargetOrderer({
      strategy: "weighted",
      random: () => 0.5,
    });
    expect(orderer([])).toEqual([]);
  });
});

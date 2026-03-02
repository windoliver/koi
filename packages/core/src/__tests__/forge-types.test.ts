import { describe, expect, test } from "bun:test";
import type { BrickKind, TrustTier } from "../index.js";
import { ALL_BRICK_KINDS, MIN_TRUST_BY_KIND } from "../index.js";

describe("ALL_BRICK_KINDS", () => {
  test("contains exactly 6 values", () => {
    expect(ALL_BRICK_KINDS).toHaveLength(6);
  });

  test("includes all expected kinds", () => {
    const expected: readonly BrickKind[] = [
      "tool",
      "skill",
      "agent",
      "middleware",
      "channel",
      "composite",
    ];
    for (const kind of expected) {
      expect(ALL_BRICK_KINDS).toContain(kind);
    }
  });

  test("has no duplicates", () => {
    const unique = new Set(ALL_BRICK_KINDS);
    expect(unique.size).toBe(ALL_BRICK_KINDS.length);
  });
});

describe("MIN_TRUST_BY_KIND", () => {
  test("has an entry for every kind in ALL_BRICK_KINDS", () => {
    for (const kind of ALL_BRICK_KINDS) {
      expect(MIN_TRUST_BY_KIND).toHaveProperty(kind);
    }
  });

  test("sandbox kinds require sandbox trust", () => {
    const sandboxKinds: readonly BrickKind[] = ["tool", "skill", "agent", "composite"];
    for (const kind of sandboxKinds) {
      expect(MIN_TRUST_BY_KIND[kind]).toBe("sandbox" satisfies TrustTier);
    }
  });

  test("middleware/channel require promoted trust", () => {
    const promotedKinds: readonly BrickKind[] = ["middleware", "channel"];
    for (const kind of promotedKinds) {
      expect(MIN_TRUST_BY_KIND[kind]).toBe("promoted" satisfies TrustTier);
    }
  });
});

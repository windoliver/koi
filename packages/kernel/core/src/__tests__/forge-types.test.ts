import { describe, expect, test } from "bun:test";
import type { BrickKind } from "../index.js";
import { ALL_BRICK_KINDS, SANDBOX_REQUIRED_BY_KIND } from "../index.js";

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

describe("SANDBOX_REQUIRED_BY_KIND", () => {
  test("has an entry for every kind in ALL_BRICK_KINDS", () => {
    for (const kind of ALL_BRICK_KINDS) {
      expect(SANDBOX_REQUIRED_BY_KIND).toHaveProperty(kind);
    }
  });

  test("sandbox kinds require sandbox", () => {
    const sandboxKinds: readonly BrickKind[] = ["tool", "skill", "agent", "composite"];
    for (const kind of sandboxKinds) {
      expect(SANDBOX_REQUIRED_BY_KIND[kind]).toBe(true);
    }
  });

  test("middleware/channel do not require sandbox", () => {
    const noSandboxKinds: readonly BrickKind[] = ["middleware", "channel"];
    for (const kind of noSandboxKinds) {
      expect(SANDBOX_REQUIRED_BY_KIND[kind]).toBe(false);
    }
  });
});

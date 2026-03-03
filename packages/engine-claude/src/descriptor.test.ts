/**
 * Tests for @koi/engine-claude BrickDescriptor metadata.
 */

import { describe, expect, test } from "bun:test";
import { descriptor } from "./descriptor.js";

describe("engine-claude descriptor", () => {
  test("has correct kind and name", () => {
    expect(descriptor.kind).toBe("engine");
    expect(descriptor.name).toBe("@koi/engine-claude");
  });

  test("includes claude alias", () => {
    expect(descriptor.aliases).toContain("claude");
  });

  test("has description", () => {
    expect(descriptor.description).toBeDefined();
    expect(typeof descriptor.description).toBe("string");
    expect(descriptor.description?.length ?? 0).toBeGreaterThan(0);
  });

  test("has tags", () => {
    expect(descriptor.tags).toBeDefined();
    expect(descriptor.tags?.length ?? 0).toBeGreaterThan(0);
    expect(descriptor.tags).toContain("claude");
    expect(descriptor.tags).toContain("agent-sdk");
  });

  test("has companion skill", () => {
    expect(descriptor.companionSkills).toBeDefined();
    expect(descriptor.companionSkills).toHaveLength(1);

    const skill = descriptor.companionSkills?.[0];
    expect(skill).toBeDefined();
    if (skill === undefined) return;
    expect(skill.name).toBe("engine-claude-guide");
    expect(skill.description).toBe("When to use engine: claude");
    expect(skill.content).toContain("## When to use");
    expect(skill.content).toContain("## When NOT to use");
    expect(skill.content).toContain("## Manifest example");
    expect(skill.tags).toContain("engine");
  });
});

describe("optionsValidator", () => {
  test("accepts valid object", () => {
    const result = descriptor.optionsValidator({});
    expect(result.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = descriptor.optionsValidator("invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("accepts null and undefined as optional", () => {
    expect(descriptor.optionsValidator(null).ok).toBe(true);
    expect(descriptor.optionsValidator(undefined).ok).toBe(true);
  });
});

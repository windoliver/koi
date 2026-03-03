/**
 * Tests for @koi/engine-pi BrickDescriptor metadata.
 */

import { describe, expect, test } from "bun:test";
import { descriptor } from "./descriptor.js";

describe("engine-pi descriptor", () => {
  test("has correct kind and name", () => {
    expect(descriptor.kind).toBe("engine");
    expect(descriptor.name).toBe("@koi/engine-pi");
  });

  test("includes pi alias", () => {
    expect(descriptor.aliases).toContain("pi");
  });

  test("has description", () => {
    expect(descriptor.description).toBeDefined();
    expect(typeof descriptor.description).toBe("string");
    expect(descriptor.description?.length ?? 0).toBeGreaterThan(0);
  });

  test("has tags", () => {
    expect(descriptor.tags).toBeDefined();
    expect(descriptor.tags?.length ?? 0).toBeGreaterThan(0);
    expect(descriptor.tags).toContain("llm");
    expect(descriptor.tags).toContain("streaming");
  });

  test("has companion skill", () => {
    expect(descriptor.companionSkills).toBeDefined();
    expect(descriptor.companionSkills).toHaveLength(1);

    const skill = descriptor.companionSkills?.[0];
    expect(skill).toBeDefined();
    if (skill === undefined) return;
    expect(skill.name).toBe("engine-pi-guide");
    expect(skill.description).toBe("When to use engine: pi");
    expect(skill.content).toContain("## When to use");
    expect(skill.content).toContain("## When NOT to use");
    expect(skill.content).toContain("## Manifest example");
    expect(skill.tags).toContain("engine");
  });
});

describe("optionsValidator", () => {
  test("accepts valid object with model", () => {
    const result = descriptor.optionsValidator({ model: "anthropic:claude-sonnet-4-5-20250929" });
    expect(result.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = descriptor.optionsValidator("invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("accepts null/undefined but requires model field", () => {
    const nullResult = descriptor.optionsValidator(null);
    expect(nullResult.ok).toBe(false);

    const undefResult = descriptor.optionsValidator(undefined);
    expect(undefResult.ok).toBe(false);
  });
});

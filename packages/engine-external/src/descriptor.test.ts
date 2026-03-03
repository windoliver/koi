/**
 * Tests for @koi/engine-external BrickDescriptor metadata.
 */

import { describe, expect, test } from "bun:test";
import { descriptor } from "./descriptor.js";

describe("engine-external descriptor", () => {
  test("has correct kind and name", () => {
    expect(descriptor.kind).toBe("engine");
    expect(descriptor.name).toBe("@koi/engine-external");
  });

  test("includes external alias", () => {
    expect(descriptor.aliases).toContain("external");
  });

  test("has description", () => {
    expect(descriptor.description).toBeDefined();
    expect(typeof descriptor.description).toBe("string");
    expect(descriptor.description?.length ?? 0).toBeGreaterThan(0);
  });

  test("has tags", () => {
    expect(descriptor.tags).toBeDefined();
    expect(descriptor.tags?.length ?? 0).toBeGreaterThan(0);
    expect(descriptor.tags).toContain("cli");
    expect(descriptor.tags).toContain("subprocess");
  });

  test("has companion skill", () => {
    expect(descriptor.companionSkills).toBeDefined();
    expect(descriptor.companionSkills).toHaveLength(1);

    const skill = descriptor.companionSkills?.[0];
    expect(skill).toBeDefined();
    if (skill === undefined) return;
    expect(skill.name).toBe("engine-external-guide");
    expect(skill.description).toBe("When to use engine: external");
    expect(skill.content).toContain("## When to use");
    expect(skill.content).toContain("## When NOT to use");
    expect(skill.content).toContain("## Manifest example");
    expect(skill.tags).toContain("engine");
  });
});

describe("optionsValidator", () => {
  test("accepts valid object with command", () => {
    const result = descriptor.optionsValidator({ command: "node" });
    expect(result.ok).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = descriptor.optionsValidator("invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects null and undefined", () => {
    expect(descriptor.optionsValidator(null).ok).toBe(false);
    expect(descriptor.optionsValidator(undefined).ok).toBe(false);
  });
});

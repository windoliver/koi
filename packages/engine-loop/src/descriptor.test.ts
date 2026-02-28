/**
 * Tests for @koi/engine-loop BrickDescriptor metadata.
 */

import { describe, expect, test } from "bun:test";
import { descriptor } from "./descriptor.js";

describe("engine-loop descriptor", () => {
  test("has correct kind and name", () => {
    expect(descriptor.kind).toBe("engine");
    expect(descriptor.name).toBe("@koi/engine-loop");
  });

  test("includes loop alias", () => {
    expect(descriptor.aliases).toContain("loop");
  });

  test("has description", () => {
    expect(descriptor.description).toBeDefined();
    expect(typeof descriptor.description).toBe("string");
    expect(descriptor.description?.length ?? 0).toBeGreaterThan(0);
  });

  test("has tags", () => {
    expect(descriptor.tags).toBeDefined();
    expect(descriptor.tags?.length ?? 0).toBeGreaterThan(0);
    expect(descriptor.tags).toContain("default");
    expect(descriptor.tags).toContain("react-loop");
  });

  test("has companion skill", () => {
    expect(descriptor.companionSkills).toBeDefined();
    expect(descriptor.companionSkills).toHaveLength(1);

    const skill = descriptor.companionSkills?.[0];
    expect(skill).toBeDefined();
    if (skill === undefined) return;
    expect(skill.name).toBe("engine-loop-guide");
    expect(skill.description).toBe("When to use engine: loop");
    expect(skill.content).toContain("## When to use");
    expect(skill.content).toContain("## When NOT to use");
    expect(skill.content).toContain("## Manifest example");
    expect(skill.tags).toContain("engine");
  });
});

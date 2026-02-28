/**
 * Tests for @koi/engine-acp BrickDescriptor metadata.
 */

import { describe, expect, test } from "bun:test";
import { descriptor } from "./descriptor.js";

describe("engine-acp descriptor", () => {
  test("has correct kind and name", () => {
    expect(descriptor.kind).toBe("engine");
    expect(descriptor.name).toBe("@koi/engine-acp");
  });

  test("includes acp alias", () => {
    expect(descriptor.aliases).toContain("acp");
  });

  test("has description", () => {
    expect(descriptor.description).toBeDefined();
    expect(typeof descriptor.description).toBe("string");
    expect(descriptor.description?.length ?? 0).toBeGreaterThan(0);
  });

  test("has tags", () => {
    expect(descriptor.tags).toBeDefined();
    expect(descriptor.tags?.length ?? 0).toBeGreaterThan(0);
    expect(descriptor.tags).toContain("acp");
    expect(descriptor.tags).toContain("coding-agent");
  });

  test("has companion skill", () => {
    expect(descriptor.companionSkills).toBeDefined();
    expect(descriptor.companionSkills).toHaveLength(1);

    const skill = descriptor.companionSkills?.[0];
    expect(skill).toBeDefined();
    if (skill === undefined) return;
    expect(skill.name).toBe("engine-acp-guide");
    expect(skill.description).toBe("When to use engine: acp");
    expect(skill.content).toContain("## When to use");
    expect(skill.content).toContain("## When NOT to use");
    expect(skill.content).toContain("## Manifest example");
    expect(skill.tags).toContain("engine");
  });
});

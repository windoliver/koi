/**
 * Unit tests for skill-stack deployment presets.
 *
 * Verifies:
 *   - All 3 presets are defined and frozen
 *   - Security thresholds are in ascending order of permissiveness
 *   - Watch defaults match preset expectations
 */

import { describe, expect, test } from "bun:test";
import { SKILL_STACK_PRESET_SPECS } from "../presets.js";

describe("SKILL_STACK_PRESET_SPECS", () => {
  test("all 3 presets are defined", () => {
    expect(SKILL_STACK_PRESET_SPECS).toHaveProperty("restrictive");
    expect(SKILL_STACK_PRESET_SPECS).toHaveProperty("standard");
    expect(SKILL_STACK_PRESET_SPECS).toHaveProperty("permissive");
  });

  test("registry is frozen", () => {
    expect(Object.isFrozen(SKILL_STACK_PRESET_SPECS)).toBe(true);
  });

  test("each preset spec is frozen", () => {
    expect(Object.isFrozen(SKILL_STACK_PRESET_SPECS.restrictive)).toBe(true);
    expect(Object.isFrozen(SKILL_STACK_PRESET_SPECS.standard)).toBe(true);
    expect(Object.isFrozen(SKILL_STACK_PRESET_SPECS.permissive)).toBe(true);
  });

  // ── Restrictive preset ─────────────────────────────────────────────────

  test("restrictive: threshold is MEDIUM", () => {
    expect(SKILL_STACK_PRESET_SPECS.restrictive.securityThreshold).toBe("MEDIUM");
  });

  test("restrictive: watch defaults to false", () => {
    expect(SKILL_STACK_PRESET_SPECS.restrictive.watchDefault).toBe(false);
  });

  // ── Standard preset ────────────────────────────────────────────────────

  test("standard: threshold is HIGH", () => {
    expect(SKILL_STACK_PRESET_SPECS.standard.securityThreshold).toBe("HIGH");
  });

  test("standard: watch defaults to true", () => {
    expect(SKILL_STACK_PRESET_SPECS.standard.watchDefault).toBe(true);
  });

  // ── Permissive preset ──────────────────────────────────────────────────

  test("permissive: threshold is CRITICAL", () => {
    expect(SKILL_STACK_PRESET_SPECS.permissive.securityThreshold).toBe("CRITICAL");
  });

  test("permissive: watch defaults to true", () => {
    expect(SKILL_STACK_PRESET_SPECS.permissive.watchDefault).toBe(true);
  });

  // ── Ordering invariant ─────────────────────────────────────────────────

  test("security thresholds get more permissive: restrictive < standard < permissive", () => {
    const order = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;
    const restrictiveLevel =
      order[SKILL_STACK_PRESET_SPECS.restrictive.securityThreshold as keyof typeof order];
    const standardLevel =
      order[SKILL_STACK_PRESET_SPECS.standard.securityThreshold as keyof typeof order];
    const permissiveLevel =
      order[SKILL_STACK_PRESET_SPECS.permissive.securityThreshold as keyof typeof order];
    expect(standardLevel).toBeGreaterThan(restrictiveLevel);
    expect(permissiveLevel).toBeGreaterThan(standardLevel);
  });
});

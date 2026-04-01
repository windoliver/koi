import { describe, expect, test } from "bun:test";
import { GOAL_STACK_PRESET_SPECS } from "../presets.js";

describe("GOAL_STACK_PRESET_SPECS", () => {
  test("defines all three presets", () => {
    expect(Object.keys(GOAL_STACK_PRESET_SPECS)).toEqual(["minimal", "standard", "autonomous"]);
  });

  test("specs are frozen", () => {
    expect(Object.isFrozen(GOAL_STACK_PRESET_SPECS)).toBe(true);
    expect(Object.isFrozen(GOAL_STACK_PRESET_SPECS.minimal)).toBe(true);
    expect(Object.isFrozen(GOAL_STACK_PRESET_SPECS.standard)).toBe(true);
    expect(Object.isFrozen(GOAL_STACK_PRESET_SPECS.autonomous)).toBe(true);
  });

  test("minimal: planning only, no anchor/reminder", () => {
    const spec = GOAL_STACK_PRESET_SPECS.minimal;
    expect(spec.includeAnchor).toBe(false);
    expect(spec.includeReminder).toBe(false);
    expect(spec.includePlanning).toBe(true);
  });

  test("standard: all three middlewares with base=5 / max=20", () => {
    const spec = GOAL_STACK_PRESET_SPECS.standard;
    expect(spec.includeAnchor).toBe(true);
    expect(spec.includeReminder).toBe(true);
    expect(spec.includePlanning).toBe(true);
    expect(spec.reminderBaseInterval).toBe(5);
    expect(spec.reminderMaxInterval).toBe(20);
  });

  test("autonomous: all three middlewares with base=3 / max=10", () => {
    const spec = GOAL_STACK_PRESET_SPECS.autonomous;
    expect(spec.includeAnchor).toBe(true);
    expect(spec.includeReminder).toBe(true);
    expect(spec.includePlanning).toBe(true);
    expect(spec.reminderBaseInterval).toBe(3);
    expect(spec.reminderMaxInterval).toBe(10);
  });
});

/**
 * Unit tests for quality-gate preset specifications.
 */

import { describe, expect, test } from "bun:test";
import { QUALITY_GATE_PRESET_SPECS } from "./presets.js";

describe("QUALITY_GATE_PRESET_SPECS", () => {
  test("contains exactly 3 presets", () => {
    expect(Object.keys(QUALITY_GATE_PRESET_SPECS)).toEqual(["light", "standard", "aggressive"]);
  });

  test("preset specs are frozen", () => {
    expect(Object.isFrozen(QUALITY_GATE_PRESET_SPECS)).toBe(true);
    expect(Object.isFrozen(QUALITY_GATE_PRESET_SPECS.light)).toBe(true);
    expect(Object.isFrozen(QUALITY_GATE_PRESET_SPECS.standard)).toBe(true);
    expect(Object.isFrozen(QUALITY_GATE_PRESET_SPECS.aggressive)).toBe(true);
  });
});

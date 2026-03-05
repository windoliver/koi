/**
 * Unit tests for retry-stack preset specifications.
 */

import { describe, expect, test } from "bun:test";
import { RETRY_STACK_PRESET_SPECS } from "./presets.js";

describe("RETRY_STACK_PRESET_SPECS", () => {
  test("contains exactly 3 presets", () => {
    expect(Object.keys(RETRY_STACK_PRESET_SPECS)).toEqual(["light", "standard", "aggressive"]);
  });

  test("light preset has no guidedRetry and no fsRollbackExpected", () => {
    const light = RETRY_STACK_PRESET_SPECS.light;
    expect(light.semanticRetry?.maxRetries).toBe(1);
    expect(light.guidedRetry).toBeUndefined();
    expect(light.fsRollbackExpected).toBeUndefined();
  });

  test("preset specs are frozen", () => {
    expect(Object.isFrozen(RETRY_STACK_PRESET_SPECS)).toBe(true);
    expect(Object.isFrozen(RETRY_STACK_PRESET_SPECS.light)).toBe(true);
    expect(Object.isFrozen(RETRY_STACK_PRESET_SPECS.standard)).toBe(true);
    expect(Object.isFrozen(RETRY_STACK_PRESET_SPECS.aggressive)).toBe(true);
  });
});

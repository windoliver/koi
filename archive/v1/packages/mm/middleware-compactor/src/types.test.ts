import { describe, expect, test } from "bun:test";
import { COMPACTOR_DEFAULTS, COMPACTOR_PRESETS } from "./types.js";

describe("COMPACTOR_DEFAULTS", () => {
  test("tokenFraction defaults to 0.60", () => {
    expect(COMPACTOR_DEFAULTS.trigger.tokenFraction).toBe(0.6);
  });

  test("softTriggerFraction defaults to 0.50", () => {
    expect(COMPACTOR_DEFAULTS.trigger.softTriggerFraction).toBe(0.5);
  });

  test("defaults are frozen", () => {
    expect(Object.isFrozen(COMPACTOR_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(COMPACTOR_DEFAULTS.trigger)).toBe(true);
    expect(Object.isFrozen(COMPACTOR_DEFAULTS.overflowRecovery)).toBe(true);
  });
});

describe("COMPACTOR_PRESETS", () => {
  test("aggressive preset has tokenFraction 0.75", () => {
    const aggressive = COMPACTOR_PRESETS.aggressive;
    expect(aggressive).toBeDefined();
    expect(aggressive?.trigger?.tokenFraction).toBe(0.75);
  });

  test("aggressive preset has no softTriggerFraction", () => {
    const aggressive = COMPACTOR_PRESETS.aggressive;
    expect(aggressive?.trigger?.softTriggerFraction).toBeUndefined();
  });

  test("presets are frozen objects", () => {
    expect(Object.isFrozen(COMPACTOR_PRESETS)).toBe(true);
    const aggressive = COMPACTOR_PRESETS.aggressive;
    expect(aggressive).toBeDefined();
    expect(Object.isFrozen(aggressive)).toBe(true);
  });
});

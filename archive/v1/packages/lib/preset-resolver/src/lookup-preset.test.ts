import { describe, expect, test } from "bun:test";
import { lookupPreset } from "./lookup-preset.js";

const SPECS = {
  light: { maxRetries: 1 },
  standard: { maxRetries: 3 },
  aggressive: { maxRetries: 5 },
} as const;

type Preset = keyof typeof SPECS;
type Spec = (typeof SPECS)[Preset];

describe("lookupPreset", () => {
  test("returns the requested preset", () => {
    const result = lookupPreset<Preset, Spec>(SPECS, "aggressive", "standard");
    expect(result.preset).toBe("aggressive");
    expect(result.spec).toEqual({ maxRetries: 5 });
  });

  test("falls back to default when preset is undefined", () => {
    const result = lookupPreset<Preset, Spec>(SPECS, undefined, "standard");
    expect(result.preset).toBe("standard");
    expect(result.spec).toEqual({ maxRetries: 3 });
  });

  test("returns the default preset spec", () => {
    const result = lookupPreset<Preset, Spec>(SPECS, undefined, "light");
    expect(result.preset).toBe("light");
    expect(result.spec).toEqual({ maxRetries: 1 });
  });

  test("throws for unknown preset name", () => {
    // Force an unknown preset at runtime via type cast
    expect(() => lookupPreset(SPECS, "nonexistent" as Preset, "standard")).toThrow(
      /Unknown preset: "nonexistent"/,
    );
  });

  test("returns frozen spec without modification", () => {
    const frozenSpecs = Object.freeze({
      a: Object.freeze({ value: 10 }),
      b: Object.freeze({ value: 20 }),
    });
    type K = keyof typeof frozenSpecs;
    const result = lookupPreset<K, (typeof frozenSpecs)[K]>(frozenSpecs, "a", "b");
    expect(result.spec).toBe(frozenSpecs.a);
  });
});

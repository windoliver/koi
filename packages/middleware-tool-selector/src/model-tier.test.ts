import { describe, expect, test } from "bun:test";
import type { CapabilityTier } from "./model-tier.js";
import { detectModelTier, MODEL_CAPABILITY_TIERS } from "./model-tier.js";

describe("MODEL_CAPABILITY_TIERS", () => {
  test("minimal tier has maxTools 5", () => {
    expect(MODEL_CAPABILITY_TIERS.minimal.maxTools).toBe(5);
  });

  test("full tier has maxTools Infinity", () => {
    expect(MODEL_CAPABILITY_TIERS.full.maxTools).toBe(Infinity);
  });
});

describe("detectModelTier", () => {
  const cases: Array<{ readonly model: string; readonly expected: CapabilityTier }> = [
    { model: "claude-3-haiku-20240307", expected: "minimal" },
    { model: "claude-haiku-4-5", expected: "minimal" },
    { model: "gpt-4o-mini", expected: "minimal" },
    { model: "claude-sonnet-4-5", expected: "standard" },
    { model: "gpt-4o-2024-08-06", expected: "standard" },
    { model: "claude-opus-4-5", expected: "advanced" },
    { model: "o3-mini", expected: "standard" },
    { model: "o3", expected: "advanced" },
    { model: "o1-mini", expected: "standard" },
    { model: "o1-preview", expected: "advanced" },
  ];

  test.each(cases)("detects $model as $expected", ({ model, expected }) => {
    expect(detectModelTier(model)).toBe(expected);
  });

  test("returns 'standard' for unknown model", () => {
    expect(detectModelTier("some-custom-model")).toBe("standard");
  });

  test("override map takes precedence over built-in patterns", () => {
    const result = detectModelTier("claude-3-haiku-20240307", {
      "claude-3-haiku-20240307": "full",
    });
    expect(result).toBe("full");
  });

  test("falls through to built-in when override has no match", () => {
    const result = detectModelTier("claude-3-haiku-20240307", {
      "other-model": "full",
    });
    expect(result).toBe("minimal");
  });
});

/**
 * Unit tests for quality-gate config resolution.
 */

import { describe, expect, test } from "bun:test";
import { resolveQualityGateConfig } from "./config-resolution.js";

describe("resolveQualityGateConfig", () => {
  test("defaults to standard preset", () => {
    const resolved = resolveQualityGateConfig({});
    expect(resolved.preset).toBe("standard");
  });

  test("light preset disables feedbackLoop and budget", () => {
    const resolved = resolveQualityGateConfig({ preset: "light" });
    expect(resolved.verifier).toBeDefined();
    expect(resolved.feedbackLoop).toBeUndefined();
    expect(resolved.maxTotalModelCalls).toBeUndefined();
  });

  test("user overrides win over preset defaults", () => {
    const resolved = resolveQualityGateConfig({
      preset: "standard",
      maxTotalModelCalls: 20,
    });
    expect(resolved.maxTotalModelCalls).toBe(20);
  });
});

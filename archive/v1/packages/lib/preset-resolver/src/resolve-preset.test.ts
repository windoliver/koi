import { describe, expect, test } from "bun:test";
import { resolvePreset } from "./resolve-preset.js";
import type { DeepPartial } from "./types.js";

type TestConfig = {
  readonly maxRetries: number;
  readonly timeout: number;
  readonly nested: {
    readonly x: number;
    readonly y: number;
  };
};

const DEFAULTS: TestConfig = {
  maxRetries: 1,
  timeout: 1000,
  nested: { x: 0, y: 0 },
};

type TestPreset = "light" | "standard" | "aggressive";

const SPECS: Record<TestPreset, DeepPartial<TestConfig>> = {
  light: { maxRetries: 1 },
  standard: { maxRetries: 3, nested: { x: 10 } },
  aggressive: { maxRetries: 5, timeout: 5000, nested: { x: 20, y: 20 } },
};

describe("resolvePreset", () => {
  test("uses default preset when none specified", () => {
    const { preset, resolved } = resolvePreset<TestConfig, TestPreset>(
      DEFAULTS,
      SPECS,
      "standard",
      {},
    );
    expect(preset).toBe("standard");
    expect(resolved.maxRetries).toBe(3);
  });

  test("applies preset over defaults", () => {
    const { resolved } = resolvePreset<TestConfig, TestPreset>(DEFAULTS, SPECS, "light", {
      preset: "aggressive",
    });
    expect(resolved.maxRetries).toBe(5);
    expect(resolved.timeout).toBe(5000);
    expect(resolved.nested).toEqual({ x: 20, y: 20 });
  });

  test("user overrides win over preset", () => {
    const { resolved } = resolvePreset<TestConfig, TestPreset>(DEFAULTS, SPECS, "standard", {
      preset: "aggressive",
      maxRetries: 10,
    });
    expect(resolved.maxRetries).toBe(10);
    // Preset value for timeout should remain
    expect(resolved.timeout).toBe(5000);
  });

  test("deep-merges nested objects across all 3 layers", () => {
    const { resolved } = resolvePreset<TestConfig, TestPreset>(DEFAULTS, SPECS, "light", {
      preset: "standard",
      nested: { y: 99 },
    });
    // defaults.nested.x=0 → preset.nested.x=10 → user doesn't override x → 10
    expect(resolved.nested.x).toBe(10);
    // defaults.nested.y=0 → preset doesn't override y → 0 → user.nested.y=99 → 99
    expect(resolved.nested.y).toBe(99);
  });

  test("returns resolved preset name", () => {
    const { preset } = resolvePreset<TestConfig, TestPreset>(DEFAULTS, SPECS, "standard", {
      preset: "light",
    });
    expect(preset).toBe("light");
  });

  test("defaults win when neither preset nor user provides value", () => {
    const { resolved } = resolvePreset<TestConfig, TestPreset>(DEFAULTS, SPECS, "light", {});
    expect(resolved.timeout).toBe(1000);
    expect(resolved.nested).toEqual({ x: 0, y: 0 });
  });
});

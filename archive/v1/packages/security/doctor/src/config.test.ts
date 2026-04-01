import { describe, expect, test } from "bun:test";
import type { AgentManifest } from "@koi/core";
import { meetsSeverityThreshold, resolveConfig, validateDoctorConfig } from "./config.js";
import type { DoctorConfig } from "./types.js";

const MINIMAL_MANIFEST: AgentManifest = {
  name: "test",
  version: "1.0.0",
  model: { name: "claude" },
};

describe("validateDoctorConfig", () => {
  test("passes with valid minimal config", () => {
    expect(() => validateDoctorConfig({ manifest: MINIMAL_MANIFEST })).not.toThrow();
  });

  test("throws when manifest is undefined", () => {
    expect(() => validateDoctorConfig({ manifest: undefined } as unknown as DoctorConfig)).toThrow(
      "manifest is required",
    );
  });

  test("throws when ruleTimeoutMs is zero", () => {
    expect(() => validateDoctorConfig({ manifest: MINIMAL_MANIFEST, ruleTimeoutMs: 0 })).toThrow(
      "ruleTimeoutMs must be positive",
    );
  });

  test("throws when ruleTimeoutMs is negative", () => {
    expect(() => validateDoctorConfig({ manifest: MINIMAL_MANIFEST, ruleTimeoutMs: -1 })).toThrow(
      "ruleTimeoutMs must be positive",
    );
  });

  test("throws when timeoutMs is zero", () => {
    expect(() => validateDoctorConfig({ manifest: MINIMAL_MANIFEST, timeoutMs: 0 })).toThrow(
      "timeoutMs must be positive",
    );
  });

  test("throws when maxFindings is zero", () => {
    expect(() => validateDoctorConfig({ manifest: MINIMAL_MANIFEST, maxFindings: 0 })).toThrow(
      "maxFindings must be positive",
    );
  });
});

describe("resolveConfig", () => {
  test("fills all defaults when no options provided", () => {
    const resolved = resolveConfig({ manifest: MINIMAL_MANIFEST });
    expect(resolved.manifest).toBe(MINIMAL_MANIFEST);
    expect(resolved.dependencies).toEqual([]);
    expect(resolved.envKeys).toBeUndefined();
    expect(resolved.enabledCategories).toHaveLength(5);
    expect(resolved.severityThreshold).toBe("LOW");
    expect(resolved.severityOverrides).toEqual({});
    expect(resolved.ruleTimeoutMs).toBe(5_000);
    expect(resolved.timeoutMs).toBe(30_000);
    expect(resolved.customRules).toEqual([]);
    expect(resolved.maxFindings).toBe(500);
    expect(resolved.advisoryCallback).toBeUndefined();
  });

  test("preserves user overrides", () => {
    const envKeys = new Set(["MY_SECRET"]);
    const overrides = { "my-rule": "CRITICAL" as const };
    const callback = () => [];
    const resolved = resolveConfig({
      manifest: MINIMAL_MANIFEST,
      severityThreshold: "HIGH",
      ruleTimeoutMs: 2_000,
      timeoutMs: 10_000,
      maxFindings: 100,
      enabledCategories: ["TOOL_SAFETY"],
      envKeys,
      severityOverrides: overrides,
      advisoryCallback: callback,
    });
    expect(resolved.severityThreshold).toBe("HIGH");
    expect(resolved.ruleTimeoutMs).toBe(2_000);
    expect(resolved.timeoutMs).toBe(10_000);
    expect(resolved.maxFindings).toBe(100);
    expect(resolved.enabledCategories).toEqual(["TOOL_SAFETY"]);
    expect(resolved.envKeys).toBe(envKeys);
    expect(resolved.severityOverrides).toBe(overrides);
    expect(resolved.advisoryCallback).toBe(callback);
  });
});

describe("meetsSeverityThreshold", () => {
  test("CRITICAL meets any threshold", () => {
    expect(meetsSeverityThreshold("CRITICAL", "LOW")).toBe(true);
    expect(meetsSeverityThreshold("CRITICAL", "CRITICAL")).toBe(true);
  });

  test("LOW does not meet HIGH threshold", () => {
    expect(meetsSeverityThreshold("LOW", "HIGH")).toBe(false);
  });
});

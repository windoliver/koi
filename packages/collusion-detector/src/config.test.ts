/**
 * Tests for collusion detector configuration validation.
 */

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_COLLUSION_THRESHOLDS,
  resolveThresholds,
  resolveWindowSize,
  validateCollusionDetectorConfig,
} from "./config.js";

describe("DEFAULT_COLLUSION_THRESHOLDS", () => {
  test("has expected defaults", () => {
    expect(DEFAULT_COLLUSION_THRESHOLDS.syncMoveMinAgents).toBe(3);
    expect(DEFAULT_COLLUSION_THRESHOLDS.syncMoveChangePct).toBe(0.2);
    expect(DEFAULT_COLLUSION_THRESHOLDS.varianceCollapseMaxCv).toBe(0.1);
    expect(DEFAULT_COLLUSION_THRESHOLDS.varianceCollapseMinRounds).toBe(5);
    expect(DEFAULT_COLLUSION_THRESHOLDS.concentrationHhiThreshold).toBe(0.25);
    expect(DEFAULT_COLLUSION_THRESHOLDS.specializationCvMin).toBe(2.0);
  });

  test("is frozen", () => {
    expect(Object.isFrozen(DEFAULT_COLLUSION_THRESHOLDS)).toBe(true);
  });
});

describe("resolveThresholds", () => {
  test("no overrides → defaults", () => {
    const t = resolveThresholds();
    expect(t).toEqual(DEFAULT_COLLUSION_THRESHOLDS);
  });

  test("partial overrides → merged with defaults", () => {
    const t = resolveThresholds({ syncMoveMinAgents: 5 });
    expect(t.syncMoveMinAgents).toBe(5);
    expect(t.syncMoveChangePct).toBe(0.2); // Default preserved
  });
});

describe("resolveWindowSize", () => {
  test("undefined → default 50", () => {
    expect(resolveWindowSize()).toBe(50);
  });

  test("provided value used", () => {
    expect(resolveWindowSize(100)).toBe(100);
  });
});

describe("validateCollusionDetectorConfig", () => {
  test("valid empty config → ok", () => {
    const result = validateCollusionDetectorConfig({});
    expect(result.ok).toBe(true);
  });

  test("valid full config → ok", () => {
    const result = validateCollusionDetectorConfig({
      windowSize: 100,
      thresholds: {
        syncMoveMinAgents: 5,
        syncMoveChangePct: 0.3,
      },
    });
    expect(result.ok).toBe(true);
  });

  test("null config → validation error", () => {
    const result = validateCollusionDetectorConfig(null);
    expect(result.ok).toBe(false);
  });

  test("undefined config → validation error", () => {
    const result = validateCollusionDetectorConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("non-object config → validation error", () => {
    const result = validateCollusionDetectorConfig(42);
    expect(result.ok).toBe(false);
  });

  test("windowSize not a positive integer → validation error", () => {
    expect(validateCollusionDetectorConfig({ windowSize: -1 }).ok).toBe(false);
    expect(validateCollusionDetectorConfig({ windowSize: 0 }).ok).toBe(false);
    expect(validateCollusionDetectorConfig({ windowSize: 1.5 }).ok).toBe(false);
    expect(validateCollusionDetectorConfig({ windowSize: "10" }).ok).toBe(false);
  });

  test("thresholds not an object → validation error", () => {
    const result = validateCollusionDetectorConfig({ thresholds: "bad" });
    expect(result.ok).toBe(false);
  });

  test("threshold value not a positive finite number → validation error", () => {
    expect(validateCollusionDetectorConfig({ thresholds: { syncMoveMinAgents: -1 } }).ok).toBe(
      false,
    );
    expect(validateCollusionDetectorConfig({ thresholds: { syncMoveMinAgents: 0 } }).ok).toBe(
      false,
    );
    expect(
      validateCollusionDetectorConfig({ thresholds: { syncMoveChangePct: Infinity } }).ok,
    ).toBe(false);
    expect(
      validateCollusionDetectorConfig({ thresholds: { concentrationHhiThreshold: NaN } }).ok,
    ).toBe(false);
  });

  test("missing optional fields → ok (defaults applied by resolveThresholds)", () => {
    const result = validateCollusionDetectorConfig({
      thresholds: { syncMoveMinAgents: 5 },
    });
    expect(result.ok).toBe(true);
  });
});

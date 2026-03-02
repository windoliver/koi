import { describe, expect, it } from "bun:test";
import {
  createDefaultExaptationConfig,
  DEFAULT_EXAPTATION_CONFIG,
  validateExaptationConfig,
} from "./config.js";

describe("DEFAULT_EXAPTATION_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_EXAPTATION_CONFIG.cooldownMs).toBe(60_000);
    expect(DEFAULT_EXAPTATION_CONFIG.maxPendingSignals).toBe(10);
    expect(DEFAULT_EXAPTATION_CONFIG.maxObservationsPerBrick).toBe(30);
    expect(DEFAULT_EXAPTATION_CONFIG.maxContextWords).toBe(200);
    expect(DEFAULT_EXAPTATION_CONFIG.thresholds?.minObservations).toBe(5);
    expect(DEFAULT_EXAPTATION_CONFIG.thresholds?.divergenceThreshold).toBe(0.7);
    expect(DEFAULT_EXAPTATION_CONFIG.thresholds?.minDivergentAgents).toBe(2);
    expect(DEFAULT_EXAPTATION_CONFIG.thresholds?.confidenceWeight).toBe(0.8);
  });
});

describe("createDefaultExaptationConfig", () => {
  it("returns defaults when no overrides", () => {
    expect(createDefaultExaptationConfig()).toBe(DEFAULT_EXAPTATION_CONFIG);
  });

  it("merges top-level overrides", () => {
    const config = createDefaultExaptationConfig({ cooldownMs: 30_000 });
    expect(config.cooldownMs).toBe(30_000);
    expect(config.maxPendingSignals).toBe(DEFAULT_EXAPTATION_CONFIG.maxPendingSignals);
  });

  it("deep-merges threshold overrides", () => {
    const config = createDefaultExaptationConfig({
      thresholds: { minObservations: 10 },
    });
    expect(config.thresholds?.minObservations).toBe(10);
    expect(config.thresholds?.divergenceThreshold).toBe(0.7);
  });

  it("preserves callback overrides", () => {
    const onSignal = () => {};
    const config = createDefaultExaptationConfig({ onSignal });
    expect(config.onSignal).toBe(onSignal);
  });
});

describe("validateExaptationConfig", () => {
  it("rejects null", () => {
    const result = validateExaptationConfig(null);
    expect(result.ok).toBe(false);
  });

  it("rejects undefined", () => {
    const result = validateExaptationConfig(undefined);
    expect(result.ok).toBe(false);
  });

  it("rejects non-object", () => {
    const result = validateExaptationConfig("string");
    expect(result.ok).toBe(false);
  });

  it("accepts empty object with defaults", () => {
    const result = validateExaptationConfig({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cooldownMs).toBe(60_000);
      expect(result.value.thresholds?.minObservations).toBe(5);
    }
  });

  it("accepts valid overrides", () => {
    const result = validateExaptationConfig({
      cooldownMs: 5000,
      maxPendingSignals: 5,
      thresholds: { minObservations: 3 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.cooldownMs).toBe(5000);
      expect(result.value.maxPendingSignals).toBe(5);
      expect(result.value.thresholds?.minObservations).toBe(3);
      expect(result.value.thresholds?.divergenceThreshold).toBe(0.7); // default
    }
  });

  it("rejects invalid cooldownMs type", () => {
    const result = validateExaptationConfig({ cooldownMs: "not a number" });
    expect(result.ok).toBe(false);
  });

  it("rejects negative cooldownMs", () => {
    const result = validateExaptationConfig({ cooldownMs: -1 });
    expect(result.ok).toBe(false);
  });

  it("rejects divergenceThreshold out of range", () => {
    const result = validateExaptationConfig({
      thresholds: { divergenceThreshold: 1.5 },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects non-function onSignal", () => {
    const result = validateExaptationConfig({ onSignal: "not a function" });
    expect(result.ok).toBe(false);
  });

  it("rejects non-function onDismiss", () => {
    const result = validateExaptationConfig({ onDismiss: 42 });
    expect(result.ok).toBe(false);
  });

  it("rejects non-function clock", () => {
    const result = validateExaptationConfig({ clock: true });
    expect(result.ok).toBe(false);
  });

  it("accepts function callbacks", () => {
    const result = validateExaptationConfig({
      onSignal: () => {},
      onDismiss: () => {},
      clock: () => 0,
    });
    expect(result.ok).toBe(true);
  });

  it("resolves full thresholds from partial input", () => {
    const result = validateExaptationConfig({
      thresholds: { confidenceWeight: 0.5 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.thresholds?.confidenceWeight).toBe(0.5);
      expect(result.value.thresholds?.minObservations).toBe(5);
      expect(result.value.thresholds?.divergenceThreshold).toBe(0.7);
      expect(result.value.thresholds?.minDivergentAgents).toBe(2);
    }
  });
});

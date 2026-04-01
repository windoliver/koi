import { describe, expect, test } from "bun:test";
import { validateRlmConfig } from "./config.js";

describe("validateRlmConfig", () => {
  test("accepts undefined", () => {
    const result = validateRlmConfig(undefined);
    expect(result.ok).toBe(true);
  });

  test("accepts null", () => {
    const result = validateRlmConfig(null);
    expect(result.ok).toBe(true);
  });

  test("accepts empty object", () => {
    const result = validateRlmConfig({});
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with all fields", () => {
    const result = validateRlmConfig({
      priority: 300,
      rootModel: "gpt-4",
      subCallModel: "gpt-3.5",
      maxIterations: 50,
      maxInputBytes: 1024,
      chunkSize: 2000,
      previewLength: 100,
      compactionThreshold: 0.7,
      contextWindowTokens: 50000,
      maxConcurrency: 3,
      depth: 0,
      onEvent: () => {},
      spawnRlmChild: async () => ({ answer: "ok", tokensUsed: 0 }),
    });
    expect(result.ok).toBe(true);
  });

  test("rejects non-object config", () => {
    const result = validateRlmConfig("invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("object");
    }
  });

  test("rejects invalid priority", () => {
    const result = validateRlmConfig({ priority: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("priority");
    }
  });

  test("rejects invalid maxIterations", () => {
    const result = validateRlmConfig({ maxIterations: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxIterations");
    }
  });

  test("rejects invalid compactionThreshold", () => {
    const result = validateRlmConfig({ compactionThreshold: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("compactionThreshold");
    }
  });

  test("rejects non-string rootModel", () => {
    const result = validateRlmConfig({ rootModel: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("rootModel");
    }
  });

  test("rejects non-function onEvent", () => {
    const result = validateRlmConfig({ onEvent: "not a function" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("onEvent");
    }
  });

  test("rejects negative depth", () => {
    const result = validateRlmConfig({ depth: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("depth");
    }
  });

  test("accepts valid scriptRunner", () => {
    const result = validateRlmConfig({
      scriptRunner: {
        run: async () => ({ ok: true, console: [], result: undefined, callCount: 0 }),
      },
    });
    expect(result.ok).toBe(true);
  });

  test("rejects non-object scriptRunner", () => {
    const result = validateRlmConfig({ scriptRunner: "not an object" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("scriptRunner");
    }
  });

  test("rejects scriptRunner without run method", () => {
    const result = validateRlmConfig({ scriptRunner: { notRun: () => {} } });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("run");
    }
  });

  // --- New fields: maxDepth, maxCostUsd, costEstimator, parentContext ---

  test("accepts valid maxDepth", () => {
    const result = validateRlmConfig({ maxDepth: 3 });
    expect(result.ok).toBe(true);
  });

  test("rejects negative maxDepth", () => {
    const result = validateRlmConfig({ maxDepth: -1 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxDepth");
    }
  });

  test("rejects non-integer maxDepth", () => {
    const result = validateRlmConfig({ maxDepth: 2.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxDepth");
    }
  });

  test("accepts valid maxCostUsd", () => {
    const result = validateRlmConfig({ maxCostUsd: 5.0 });
    expect(result.ok).toBe(true);
  });

  test("rejects non-positive maxCostUsd", () => {
    const result = validateRlmConfig({ maxCostUsd: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("maxCostUsd");
    }
  });

  test("accepts valid costEstimator function", () => {
    const result = validateRlmConfig({
      costEstimator: () => 0.001,
    });
    expect(result.ok).toBe(true);
  });

  test("rejects non-function costEstimator", () => {
    const result = validateRlmConfig({ costEstimator: "not a function" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("costEstimator");
    }
  });

  test("accepts valid parentContext", () => {
    const result = validateRlmConfig({ parentContext: "Parent was analyzing API endpoints" });
    expect(result.ok).toBe(true);
  });

  test("rejects non-string parentContext", () => {
    const result = validateRlmConfig({ parentContext: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("parentContext");
    }
  });
});

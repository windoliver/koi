import { describe, expect, it } from "bun:test";
import {
  DEFAULT_MODEL_WINDOW,
  isKnownModel,
  MODEL_WINDOWS,
  resolveModelWindow,
} from "./registry.js";

describe("MODEL_WINDOWS", () => {
  it("contains at least 6 calibrated models", () => {
    expect(Object.keys(MODEL_WINDOWS).length).toBeGreaterThanOrEqual(6);
  });

  it("all window values are positive integers", () => {
    for (const [model, window] of Object.entries(MODEL_WINDOWS)) {
      expect(window, `${model} must be a positive integer`).toBeGreaterThan(0);
      expect(Number.isInteger(window), `${model} must be an integer`).toBe(true);
    }
  });
});

describe("resolveModelWindow", () => {
  it("returns the exact registered window for a known Anthropic model", () => {
    expect(resolveModelWindow("claude-opus-4-6")).toBe(1_000_000);
  });

  it("returns the exact registered window for a known OpenAI model", () => {
    expect(resolveModelWindow("gpt-4o")).toBe(128_000);
  });

  it("returns the exact registered window for a known Google model", () => {
    expect(resolveModelWindow("gemini-2.5-pro")).toBe(1_000_000);
  });

  it("returns DEFAULT_MODEL_WINDOW for an unknown model", () => {
    expect(resolveModelWindow("totally-unknown-model-xyz")).toBe(DEFAULT_MODEL_WINDOW);
  });

  it("returns DEFAULT_MODEL_WINDOW for an empty string", () => {
    expect(resolveModelWindow("")).toBe(DEFAULT_MODEL_WINDOW);
  });

  it("prefers caller overrides over the built-in registry", () => {
    const overrides = { "claude-opus-4-6": 500_000 };
    expect(resolveModelWindow("claude-opus-4-6", overrides)).toBe(500_000);
  });

  it("prefers caller overrides over DEFAULT_MODEL_WINDOW for unknown models", () => {
    const overrides = { "my-private-model": 64_000 };
    expect(resolveModelWindow("my-private-model", overrides)).toBe(64_000);
  });

  it("falls through to built-in registry when override does not contain the model", () => {
    const overrides = { "some-other-model": 50_000 };
    expect(resolveModelWindow("claude-sonnet-4-6", overrides)).toBe(200_000);
  });

  it("falls through to DEFAULT_MODEL_WINDOW when overrides is empty", () => {
    expect(resolveModelWindow("unknown-model", {})).toBe(DEFAULT_MODEL_WINDOW);
  });

  it("works without overrides argument (no crash)", () => {
    expect(() => resolveModelWindow("claude-sonnet-4-6")).not.toThrow();
  });
});

describe("isKnownModel", () => {
  it("returns true for a known model", () => {
    expect(isKnownModel("claude-opus-4-6")).toBe(true);
  });

  it("returns true for all entries in MODEL_WINDOWS", () => {
    for (const modelId of Object.keys(MODEL_WINDOWS)) {
      expect(isKnownModel(modelId), `expected ${modelId} to be known`).toBe(true);
    }
  });

  it("returns false for an unknown model", () => {
    expect(isKnownModel("definitely-not-a-real-model")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isKnownModel("")).toBe(false);
  });
});

describe("DEFAULT_MODEL_WINDOW", () => {
  it("is a positive integer", () => {
    expect(DEFAULT_MODEL_WINDOW).toBeGreaterThan(0);
    expect(Number.isInteger(DEFAULT_MODEL_WINDOW)).toBe(true);
  });

  it("is at most the smallest known model window (conservative baseline)", () => {
    const smallest = Math.min(...Object.values(MODEL_WINDOWS));
    expect(DEFAULT_MODEL_WINDOW).toBeLessThanOrEqual(smallest);
  });
});

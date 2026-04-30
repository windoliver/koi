import { describe, expect, test } from "bun:test";
import { validateRlmConfig } from "./config.js";

describe("validateRlmConfig", () => {
  test("accepts undefined and returns an empty config", () => {
    const r = validateRlmConfig(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({});
  });

  test("rejects non-object configs", () => {
    expect(validateRlmConfig(null).ok).toBe(false);
    expect(validateRlmConfig(42).ok).toBe(false);
    expect(validateRlmConfig([]).ok).toBe(false);
  });

  test("accepts a fully populated config", () => {
    const r = validateRlmConfig({
      maxInputTokens: 1_000,
      maxChunkChars: 200,
      priority: 150,
      estimator: { estimateText: () => 0, estimateMessages: () => 0 },
      onEvent: () => undefined,
    });
    expect(r.ok).toBe(true);
  });

  test("rejects non-positive maxInputTokens", () => {
    expect(validateRlmConfig({ maxInputTokens: 0 }).ok).toBe(false);
    expect(validateRlmConfig({ maxInputTokens: -1 }).ok).toBe(false);
    expect(validateRlmConfig({ maxInputTokens: 1.5 }).ok).toBe(false);
  });

  test("rejects non-positive maxChunkChars", () => {
    expect(validateRlmConfig({ maxChunkChars: 0 }).ok).toBe(false);
    expect(validateRlmConfig({ maxChunkChars: 1.5 }).ok).toBe(false);
  });

  test("rejects malformed estimator", () => {
    expect(validateRlmConfig({ estimator: {} }).ok).toBe(false);
    expect(validateRlmConfig({ estimator: { estimateText: () => 0 } }).ok).toBe(false);
  });

  test("rejects non-function onEvent", () => {
    expect(validateRlmConfig({ onEvent: 42 }).ok).toBe(false);
  });

  test("rejects non-integer priority", () => {
    expect(validateRlmConfig({ priority: 1.5 }).ok).toBe(false);
    expect(validateRlmConfig({ priority: Number.NaN }).ok).toBe(false);
  });
});

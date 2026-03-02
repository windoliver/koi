import { describe, expect, test } from "bun:test";
import { validatePersonalizationConfig } from "./config.js";

function createMockMemory(): { recall: () => Promise<readonly []>; store: () => Promise<void> } {
  return {
    async recall(): Promise<readonly []> {
      return [];
    },
    async store(): Promise<void> {},
  };
}

describe("validatePersonalizationConfig", () => {
  const memory = createMockMemory();

  test("accepts valid config with required fields", () => {
    const result = validatePersonalizationConfig({ memory });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validatePersonalizationConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined config", () => {
    const result = validatePersonalizationConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects config without memory", () => {
    const result = validatePersonalizationConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("memory");
  });

  test("rejects memory without recall method", () => {
    const result = validatePersonalizationConfig({ memory: { store: () => {} } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("memory");
  });

  test("rejects memory without store method", () => {
    const result = validatePersonalizationConfig({ memory: { recall: () => {} } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("memory");
  });

  test("rejects negative relevanceThreshold", () => {
    const result = validatePersonalizationConfig({ memory, relevanceThreshold: -0.1 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("relevanceThreshold");
  });

  test("rejects relevanceThreshold greater than 1", () => {
    const result = validatePersonalizationConfig({ memory, relevanceThreshold: 1.5 });
    expect(result.ok).toBe(false);
  });

  test("accepts relevanceThreshold of 0", () => {
    const result = validatePersonalizationConfig({ memory, relevanceThreshold: 0 });
    expect(result.ok).toBe(true);
  });

  test("accepts relevanceThreshold of 1", () => {
    const result = validatePersonalizationConfig({ memory, relevanceThreshold: 1 });
    expect(result.ok).toBe(true);
  });

  test("rejects negative maxPreferenceTokens", () => {
    const result = validatePersonalizationConfig({ memory, maxPreferenceTokens: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects zero maxPreferenceTokens", () => {
    const result = validatePersonalizationConfig({ memory, maxPreferenceTokens: 0 });
    expect(result.ok).toBe(false);
  });

  test("accepts positive maxPreferenceTokens", () => {
    const result = validatePersonalizationConfig({ memory, maxPreferenceTokens: 200 });
    expect(result.ok).toBe(true);
  });

  test("accepts config with all optional fields", () => {
    const result = validatePersonalizationConfig({
      memory,
      relevanceThreshold: 0.8,
      maxPreferenceTokens: 300,
      preferenceNamespace: "user-prefs",
    });
    expect(result.ok).toBe(true);
  });

  test("all errors are non-retryable", () => {
    const result = validatePersonalizationConfig(null);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});

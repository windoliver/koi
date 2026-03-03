import { describe, expect, test } from "bun:test";
import { validatePreferenceConfig } from "./config.js";

describe("validatePreferenceConfig", () => {
  test("accepts valid full config", () => {
    const result = validatePreferenceConfig({
      driftDetector: { detect: () => ({ kind: "no_drift" }) },
      salienceGate: { isSalient: () => true },
      classify: async (_p: string) => "NO",
      recallLimit: 10,
      preferenceCategory: "user-pref",
      memory: { recall: async () => [], store: async () => {} },
    });

    expect(result.ok).toBe(true);
  });

  test("accepts valid minimal config (empty object)", () => {
    const result = validatePreferenceConfig({});
    expect(result.ok).toBe(true);
  });

  test("rejects non-object config", () => {
    const result = validatePreferenceConfig("not an object");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  test("rejects invalid recallLimit", () => {
    const result = validatePreferenceConfig({ recallLimit: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("recallLimit");
    }
  });

  test("rejects empty preferenceCategory", () => {
    const result = validatePreferenceConfig({ preferenceCategory: "" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("preferenceCategory");
    }
  });

  test("rejects classify that is not a function", () => {
    const result = validatePreferenceConfig({ classify: "not a function" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("classify");
    }
  });
});

import { describe, expect, test } from "bun:test";
import type { UserSnapshot } from "@koi/core/user-model";
import type { ContextBudget } from "./context-injector.js";
import { formatUserContext } from "./context-injector.js";

const DEFAULT_BUDGET: ContextBudget = {
  maxPreferenceTokens: 400,
  maxSensorTokens: 100,
  maxMetaTokens: 100,
};

function createSnapshot(overrides: Partial<UserSnapshot> = {}): UserSnapshot {
  return {
    preferences: [],
    state: {},
    ambiguityDetected: false,
    ...overrides,
  };
}

describe("formatUserContext", () => {
  test("returns undefined when all sections empty", () => {
    const snapshot = createSnapshot();
    expect(formatUserContext(snapshot, DEFAULT_BUDGET)).toBeUndefined();
  });

  test("includes preferences section when present", () => {
    const snapshot = createSnapshot({
      preferences: [
        { content: "Use dark mode", score: 0.9 },
        { content: "Prefer tabs", score: 0.85 },
      ],
    });
    const result = formatUserContext(snapshot, DEFAULT_BUDGET);
    expect(result).toContain("[User Context]");
    expect(result).toContain("Use dark mode");
    expect(result).toContain("Prefer tabs");
  });

  test("includes sensor state section when present", () => {
    const snapshot = createSnapshot({
      state: { ide: "vscode", theme: "dark" },
    });
    const result = formatUserContext(snapshot, DEFAULT_BUDGET);
    expect(result).toContain("[User Context]");
    expect(result).toContain("Sensor State:");
    expect(result).toContain("ide");
    expect(result).toContain("vscode");
  });

  test("includes clarification when ambiguity detected", () => {
    const snapshot = createSnapshot({
      ambiguityDetected: true,
      suggestedQuestion: "Which format do you prefer?",
    });
    const result = formatUserContext(snapshot, DEFAULT_BUDGET);
    expect(result).toContain("Clarification Needed");
    expect(result).toContain("Which format do you prefer?");
  });

  test("preferences exceeding budget are truncated", () => {
    const longPrefs = Array.from({ length: 50 }, (_, i) => ({
      content: `Preference ${i}: ${"x".repeat(100)}`,
      score: 0.9,
    }));
    const snapshot = createSnapshot({ preferences: longPrefs });
    const result = formatUserContext(snapshot, { ...DEFAULT_BUDGET, maxPreferenceTokens: 50 });
    expect(result).toBeDefined();
    // Should have fewer preferences than the full list
    const prefCount = (result ?? "").split("Preference ").length - 1;
    expect(prefCount).toBeLessThan(50);
  });

  test("empty sensor state produces no sensor section", () => {
    const snapshot = createSnapshot({
      preferences: [{ content: "pref", score: 0.9 }],
      state: {},
    });
    const result = formatUserContext(snapshot, DEFAULT_BUDGET);
    expect(result).not.toContain("Sensor State:");
  });

  test("combines all sections into single [User Context] block", () => {
    const snapshot = createSnapshot({
      preferences: [{ content: "Use vim", score: 0.9 }],
      state: { os: "linux" },
      ambiguityDetected: true,
      suggestedQuestion: "Which shell?",
    });
    const result = formatUserContext(snapshot, DEFAULT_BUDGET);
    expect(result).toBeDefined();
    // Should start with [User Context]
    expect(result?.startsWith("[User Context]")).toBe(true);
    // All three sections present
    expect(result).toContain("Preferences:");
    expect(result).toContain("Sensor State:");
    expect(result).toContain("Clarification Needed");
  });
});

import { describe, expect, test } from "bun:test";
import { validateReflexConfig } from "./config.js";
import type { ReflexRule } from "./types.js";

const stubRule: ReflexRule = {
  name: "test",
  match: () => true,
  respond: () => "hi",
};

describe("validateReflexConfig", () => {
  // --- valid configs ---

  test("accepts minimal config with rules only", () => {
    const result = validateReflexConfig({ rules: [stubRule] });
    expect(result.ok).toBe(true);
  });

  test("accepts full config with all optional fields", () => {
    const result = validateReflexConfig({
      rules: [{ ...stubRule, priority: 50, cooldownMs: 1000 }],
      enabled: false,
      now: () => 0,
      onMetrics: () => {},
    });
    expect(result.ok).toBe(true);
  });

  // --- invalid top-level ---

  test("rejects null", () => {
    const result = validateReflexConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects string", () => {
    const result = validateReflexConfig("bad");
    expect(result.ok).toBe(false);
  });

  test("rejects array", () => {
    const result = validateReflexConfig([]);
    expect(result.ok).toBe(false);
  });

  test("rejects number", () => {
    const result = validateReflexConfig(42);
    expect(result.ok).toBe(false);
  });

  // --- invalid rules ---

  test("rejects empty rules array", () => {
    const result = validateReflexConfig({ rules: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-empty");
  });

  test("rejects missing rules", () => {
    const result = validateReflexConfig({});
    expect(result.ok).toBe(false);
  });

  test("rejects rule missing name", () => {
    const result = validateReflexConfig({
      rules: [{ match: () => true, respond: () => "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("name");
  });

  test("rejects rule missing match", () => {
    const result = validateReflexConfig({
      rules: [{ name: "r", respond: () => "x" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("match");
  });

  test("rejects rule missing respond", () => {
    const result = validateReflexConfig({
      rules: [{ name: "r", match: () => true }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("respond");
  });

  // --- invalid rule fields ---

  test("rejects negative priority", () => {
    const result = validateReflexConfig({
      rules: [{ ...stubRule, priority: -1 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("priority");
  });

  test("rejects negative cooldownMs", () => {
    const result = validateReflexConfig({
      rules: [{ ...stubRule, cooldownMs: -5 }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("cooldownMs");
  });

  // --- invalid optional fields ---

  test("rejects non-boolean enabled", () => {
    const result = validateReflexConfig({ rules: [stubRule], enabled: "yes" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("enabled");
  });

  test("rejects non-function now", () => {
    const result = validateReflexConfig({ rules: [stubRule], now: 123 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("now");
  });

  test("rejects non-function onMetrics", () => {
    const result = validateReflexConfig({ rules: [stubRule], onMetrics: "cb" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("onMetrics");
  });
});

/**
 * Tests for validateGoalReminderConfig.
 */

import { describe, expect, test } from "bun:test";
import { validateGoalReminderConfig } from "./config.js";

describe("validateGoalReminderConfig", () => {
  const validConfig = {
    sources: [{ kind: "manifest", objectives: ["goal 1"] }],
    baseInterval: 5,
    maxInterval: 20,
  };

  test("returns ok for valid config", () => {
    const result = validateGoalReminderConfig(validConfig);
    expect(result.ok).toBe(true);
  });

  test("returns ok with all optional fields", () => {
    const result = validateGoalReminderConfig({
      ...validConfig,
      isDrifting: () => false,
      header: "Custom Header",
    });
    expect(result.ok).toBe(true);
  });

  // --- null / undefined / non-object ---

  test("rejects null", () => {
    const result = validateGoalReminderConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects undefined", () => {
    const result = validateGoalReminderConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object", () => {
    const result = validateGoalReminderConfig("not an object");
    expect(result.ok).toBe(false);
  });

  // --- sources ---

  test("rejects missing sources", () => {
    const result = validateGoalReminderConfig({ baseInterval: 5, maxInterval: 20 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("sources");
  });

  test("rejects empty sources array", () => {
    const result = validateGoalReminderConfig({ ...validConfig, sources: [] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-empty");
  });

  test("rejects source with invalid kind", () => {
    const result = validateGoalReminderConfig({
      ...validConfig,
      sources: [{ kind: "unknown" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("ReminderSource");
  });

  test("rejects manifest source without objectives array", () => {
    const result = validateGoalReminderConfig({
      ...validConfig,
      sources: [{ kind: "manifest", objectives: "not an array" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects static source without text", () => {
    const result = validateGoalReminderConfig({
      ...validConfig,
      sources: [{ kind: "static", text: 42 }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects dynamic source without fetch function", () => {
    const result = validateGoalReminderConfig({
      ...validConfig,
      sources: [{ kind: "dynamic", fetch: "not a function" }],
    });
    expect(result.ok).toBe(false);
  });

  test("rejects tasks source without provider function", () => {
    const result = validateGoalReminderConfig({
      ...validConfig,
      sources: [{ kind: "tasks", provider: null }],
    });
    expect(result.ok).toBe(false);
  });

  test("accepts all valid source kinds", () => {
    const result = validateGoalReminderConfig({
      ...validConfig,
      sources: [
        { kind: "manifest", objectives: ["a"] },
        { kind: "static", text: "b" },
        { kind: "dynamic", fetch: (_ctx: unknown) => "c" },
        { kind: "tasks", provider: (_ctx: unknown) => ["d"] },
      ],
    });
    expect(result.ok).toBe(true);
  });

  // --- baseInterval ---

  test("rejects baseInterval < 1", () => {
    const result = validateGoalReminderConfig({ ...validConfig, baseInterval: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("baseInterval");
  });

  test("rejects non-number baseInterval", () => {
    const result = validateGoalReminderConfig({ ...validConfig, baseInterval: "5" });
    expect(result.ok).toBe(false);
  });

  test("rejects NaN baseInterval", () => {
    const result = validateGoalReminderConfig({ ...validConfig, baseInterval: NaN });
    expect(result.ok).toBe(false);
  });

  test("rejects Infinity baseInterval", () => {
    const result = validateGoalReminderConfig({ ...validConfig, baseInterval: Infinity });
    expect(result.ok).toBe(false);
  });

  test("rejects fractional baseInterval", () => {
    const result = validateGoalReminderConfig({ ...validConfig, baseInterval: 2.5 });
    expect(result.ok).toBe(false);
  });

  // --- maxInterval ---

  test("rejects maxInterval < baseInterval", () => {
    const result = validateGoalReminderConfig({ ...validConfig, maxInterval: 3 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("maxInterval");
  });

  test("rejects Infinity maxInterval", () => {
    const result = validateGoalReminderConfig({ ...validConfig, maxInterval: Infinity });
    expect(result.ok).toBe(false);
  });

  test("rejects fractional maxInterval", () => {
    const result = validateGoalReminderConfig({ ...validConfig, maxInterval: 20.5 });
    expect(result.ok).toBe(false);
  });

  test("accepts maxInterval equal to baseInterval", () => {
    const result = validateGoalReminderConfig({ ...validConfig, baseInterval: 5, maxInterval: 5 });
    expect(result.ok).toBe(true);
  });

  // --- isDrifting ---

  test("rejects non-function isDrifting", () => {
    const result = validateGoalReminderConfig({ ...validConfig, isDrifting: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("isDrifting");
  });

  // --- header ---

  test("rejects non-string header", () => {
    const result = validateGoalReminderConfig({ ...validConfig, header: 42 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("header");
  });

  test("all validation errors are non-retryable", () => {
    const result = validateGoalReminderConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});

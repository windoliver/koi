import { describe, expect, test } from "bun:test";
import { validateModelCallLimitConfig, validateToolCallLimitConfig } from "./config.js";

describe("validateToolCallLimitConfig", () => {
  test("rejects null/undefined/non-object", () => {
    expect(validateToolCallLimitConfig(null).ok).toBe(false);
    expect(validateToolCallLimitConfig(undefined).ok).toBe(false);
    expect(validateToolCallLimitConfig("x").ok).toBe(false);
    expect(validateToolCallLimitConfig([]).ok).toBe(false);
  });

  test("requires limits or globalLimit", () => {
    const r = validateToolCallLimitConfig({});
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toContain("limits");
  });

  test("rejects negative or non-integer per-tool limit", () => {
    expect(validateToolCallLimitConfig({ limits: { foo: -1 } }).ok).toBe(false);
    expect(validateToolCallLimitConfig({ limits: { foo: 1.5 } }).ok).toBe(false);
    expect(validateToolCallLimitConfig({ limits: { foo: "1" } }).ok).toBe(false);
  });

  test("rejects bad globalLimit", () => {
    expect(validateToolCallLimitConfig({ globalLimit: -1 }).ok).toBe(false);
    expect(validateToolCallLimitConfig({ globalLimit: 1.5 }).ok).toBe(false);
  });

  test("accepts valid config", () => {
    const r = validateToolCallLimitConfig({ limits: { foo: 3 }, globalLimit: 10 });
    expect(r.ok).toBe(true);
  });

  test("rejects bad exitBehavior", () => {
    expect(validateToolCallLimitConfig({ globalLimit: 1, exitBehavior: "explode" }).ok).toBe(false);
  });

  test("rejects non-function onLimitReached", () => {
    expect(validateToolCallLimitConfig({ globalLimit: 1, onLimitReached: "x" }).ok).toBe(false);
  });

  test("rejects bad store shape", () => {
    expect(validateToolCallLimitConfig({ globalLimit: 1, store: { get: () => 0 } }).ok).toBe(false);
  });
});

describe("validateModelCallLimitConfig", () => {
  test("rejects missing limit", () => {
    expect(validateModelCallLimitConfig({}).ok).toBe(false);
  });

  test("rejects negative or non-integer limit", () => {
    expect(validateModelCallLimitConfig({ limit: -1 }).ok).toBe(false);
    expect(validateModelCallLimitConfig({ limit: 1.5 }).ok).toBe(false);
  });

  test("accepts valid config", () => {
    expect(validateModelCallLimitConfig({ limit: 100 }).ok).toBe(true);
  });

  test("rejects bad exitBehavior", () => {
    expect(validateModelCallLimitConfig({ limit: 1, exitBehavior: "continue" }).ok).toBe(false);
  });
});

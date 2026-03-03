import { describe, expect, test } from "bun:test";
import { validateModelCallLimitConfig, validateToolCallLimitConfig } from "./config.js";
import { createInMemoryCallLimitStore } from "./store.js";

describe("validateModelCallLimitConfig", () => {
  test("accepts valid config with required fields only", () => {
    const result = validateModelCallLimitConfig({ limit: 10 });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with all optional fields", () => {
    const result = validateModelCallLimitConfig({
      limit: 5,
      store: createInMemoryCallLimitStore(),
      exitBehavior: "end",
      onLimitReached: () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateModelCallLimitConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("non-null object");
  });

  test("rejects undefined config", () => {
    const result = validateModelCallLimitConfig(undefined);
    expect(result.ok).toBe(false);
  });

  test("rejects non-object config", () => {
    const result = validateModelCallLimitConfig("bad");
    expect(result.ok).toBe(false);
  });

  test("rejects missing limit", () => {
    const result = validateModelCallLimitConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("limit");
  });

  test("rejects negative limit", () => {
    const result = validateModelCallLimitConfig({ limit: -1 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer limit", () => {
    const result = validateModelCallLimitConfig({ limit: 3.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("integer");
  });

  test("rejects Infinity limit", () => {
    const result = validateModelCallLimitConfig({ limit: Infinity });
    expect(result.ok).toBe(false);
  });

  test("rejects NaN limit", () => {
    const result = validateModelCallLimitConfig({ limit: NaN });
    expect(result.ok).toBe(false);
  });

  test("accepts limit of 0", () => {
    const result = validateModelCallLimitConfig({ limit: 0 });
    expect(result.ok).toBe(true);
  });

  test("rejects null store", () => {
    const result = validateModelCallLimitConfig({ limit: 5, store: null });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("store");
  });

  test("rejects store without required methods", () => {
    const result = validateModelCallLimitConfig({ limit: 5, store: { get: () => 0 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("get, increment, and reset");
  });

  test("rejects invalid exitBehavior", () => {
    const result = validateModelCallLimitConfig({ limit: 5, exitBehavior: "continue" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("exitBehavior");
  });

  test("accepts exitBehavior 'end'", () => {
    const result = validateModelCallLimitConfig({ limit: 5, exitBehavior: "end" });
    expect(result.ok).toBe(true);
  });

  test("accepts exitBehavior 'error'", () => {
    const result = validateModelCallLimitConfig({ limit: 5, exitBehavior: "error" });
    expect(result.ok).toBe(true);
  });

  test("rejects non-function onLimitReached", () => {
    const result = validateModelCallLimitConfig({ limit: 5, onLimitReached: "not-fn" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("onLimitReached");
  });

  test("all validation errors have VALIDATION code", () => {
    const result = validateModelCallLimitConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("all validation errors are not retryable", () => {
    const result = validateModelCallLimitConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.retryable).toBe(false);
  });
});

describe("validateToolCallLimitConfig", () => {
  test("accepts valid config with globalLimit only", () => {
    const result = validateToolCallLimitConfig({ globalLimit: 10 });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with limits only", () => {
    const result = validateToolCallLimitConfig({ limits: { search: 5, read: 10 } });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with both limits and globalLimit", () => {
    const result = validateToolCallLimitConfig({ limits: { search: 5 }, globalLimit: 20 });
    expect(result.ok).toBe(true);
  });

  test("accepts valid config with all optional fields", () => {
    const result = validateToolCallLimitConfig({
      globalLimit: 10,
      store: createInMemoryCallLimitStore(),
      exitBehavior: "continue",
      onLimitReached: () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("rejects null config", () => {
    const result = validateToolCallLimitConfig(null);
    expect(result.ok).toBe(false);
  });

  test("rejects config with neither limits nor globalLimit", () => {
    const result = validateToolCallLimitConfig({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("at least one");
  });

  test("rejects null limits", () => {
    const result = validateToolCallLimitConfig({ limits: null });
    expect(result.ok).toBe(false);
  });

  test("rejects array limits", () => {
    const result = validateToolCallLimitConfig({ limits: [1, 2] });
    expect(result.ok).toBe(false);
  });

  test("rejects negative per-tool limit", () => {
    const result = validateToolCallLimitConfig({ limits: { search: -1 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("search");
  });

  test("rejects non-integer per-tool limit", () => {
    const result = validateToolCallLimitConfig({ limits: { search: 2.5 } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("integer");
  });

  test("rejects negative globalLimit", () => {
    const result = validateToolCallLimitConfig({ globalLimit: -5 });
    expect(result.ok).toBe(false);
  });

  test("rejects non-integer globalLimit", () => {
    const result = validateToolCallLimitConfig({ globalLimit: 1.5 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("integer");
  });

  test("rejects Infinity globalLimit", () => {
    const result = validateToolCallLimitConfig({ globalLimit: Infinity });
    expect(result.ok).toBe(false);
  });

  test("accepts globalLimit of 0", () => {
    const result = validateToolCallLimitConfig({ globalLimit: 0 });
    expect(result.ok).toBe(true);
  });

  test("accepts per-tool limit of 0", () => {
    const result = validateToolCallLimitConfig({ limits: { search: 0 } });
    expect(result.ok).toBe(true);
  });

  test("rejects invalid exitBehavior", () => {
    const result = validateToolCallLimitConfig({ globalLimit: 5, exitBehavior: "abort" });
    expect(result.ok).toBe(false);
  });

  test("accepts all valid tool exitBehavior values", () => {
    for (const behavior of ["continue", "end", "error"]) {
      const result = validateToolCallLimitConfig({ globalLimit: 5, exitBehavior: behavior });
      expect(result.ok).toBe(true);
    }
  });

  test("rejects non-function onLimitReached", () => {
    const result = validateToolCallLimitConfig({ globalLimit: 5, onLimitReached: 42 });
    expect(result.ok).toBe(false);
  });

  test("rejects store without required methods", () => {
    const result = validateToolCallLimitConfig({ globalLimit: 5, store: {} });
    expect(result.ok).toBe(false);
  });

  test("all validation errors have VALIDATION code", () => {
    const result = validateToolCallLimitConfig(null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});

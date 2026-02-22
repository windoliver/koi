import { describe, expect, test } from "bun:test";
import type { KoiErrorCode } from "../index.js";
import { RETRYABLE_DEFAULTS } from "../index.js";

describe("RETRYABLE_DEFAULTS", () => {
  test("contains exactly 8 entries (one per KoiErrorCode)", () => {
    expect(Object.keys(RETRYABLE_DEFAULTS)).toHaveLength(8);
  });

  test("VALIDATION is not retryable", () => {
    expect(RETRYABLE_DEFAULTS.VALIDATION).toBe(false);
  });

  test("NOT_FOUND is not retryable", () => {
    expect(RETRYABLE_DEFAULTS.NOT_FOUND).toBe(false);
  });

  test("PERMISSION is not retryable", () => {
    expect(RETRYABLE_DEFAULTS.PERMISSION).toBe(false);
  });

  test("CONFLICT is retryable", () => {
    expect(RETRYABLE_DEFAULTS.CONFLICT).toBe(true);
  });

  test("RATE_LIMIT is retryable", () => {
    expect(RETRYABLE_DEFAULTS.RATE_LIMIT).toBe(true);
  });

  test("TIMEOUT is retryable", () => {
    expect(RETRYABLE_DEFAULTS.TIMEOUT).toBe(true);
  });

  test("EXTERNAL defaults to not retryable", () => {
    expect(RETRYABLE_DEFAULTS.EXTERNAL).toBe(false);
  });

  test("INTERNAL is not retryable", () => {
    expect(RETRYABLE_DEFAULTS.INTERNAL).toBe(false);
  });

  test("all values are booleans", () => {
    for (const value of Object.values(RETRYABLE_DEFAULTS)) {
      expect(typeof value).toBe("boolean");
    }
  });

  test("satisfies Record<KoiErrorCode, boolean> at type level", () => {
    // This assignment verifies the type at compile time
    const _typeCheck: Readonly<Record<KoiErrorCode, boolean>> = RETRYABLE_DEFAULTS;
    expect(_typeCheck).toBe(RETRYABLE_DEFAULTS);
  });

  test("is frozen at runtime", () => {
    expect(Object.isFrozen(RETRYABLE_DEFAULTS)).toBe(true);
  });
});

import { describe, expect, test } from "bun:test";
import type { KoiErrorCode } from "../index.js";
import { RETRYABLE_DEFAULTS } from "../index.js";

describe("RETRYABLE_DEFAULTS", () => {
  test("contains exactly 10 entries (one per KoiErrorCode)", () => {
    expect(Object.keys(RETRYABLE_DEFAULTS)).toHaveLength(10);
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

  test("STALE_REF is not retryable", () => {
    expect(RETRYABLE_DEFAULTS.STALE_REF).toBe(false);
  });

  test("AUTH_REQUIRED is retryable (user can complete authorization)", () => {
    expect(RETRYABLE_DEFAULTS.AUTH_REQUIRED).toBe(true);
  });

  test("keys match every KoiErrorCode", () => {
    // Runtime: verify keys match the expected set
    const expectedCodes: readonly KoiErrorCode[] = [
      "VALIDATION",
      "NOT_FOUND",
      "PERMISSION",
      "CONFLICT",
      "RATE_LIMIT",
      "TIMEOUT",
      "EXTERNAL",
      "INTERNAL",
      "STALE_REF",
      "AUTH_REQUIRED",
    ];
    const actualKeys = Object.keys(RETRYABLE_DEFAULTS).sort();
    const expectedKeys = [...expectedCodes].sort();
    expect(actualKeys).toEqual(expectedKeys);

    // Compile-time: verify RETRYABLE_DEFAULTS satisfies Record<KoiErrorCode, boolean>
    const _typeCheck: Readonly<Record<KoiErrorCode, boolean>> = RETRYABLE_DEFAULTS;
    void _typeCheck;
  });

  test("is frozen at runtime", () => {
    expect(Object.isFrozen(RETRYABLE_DEFAULTS)).toBe(true);
  });
});

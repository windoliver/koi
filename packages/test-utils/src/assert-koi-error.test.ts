import { describe, expect, test } from "bun:test";
import { assertKoiError } from "./assert-koi-error.js";

describe("assertKoiError", () => {
  test("passes for valid KoiError", () => {
    assertKoiError({ code: "INTERNAL", message: "fail", retryable: false });
  });

  test("passes for all 8 valid codes", () => {
    const codes = [
      "VALIDATION",
      "NOT_FOUND",
      "PERMISSION",
      "CONFLICT",
      "RATE_LIMIT",
      "TIMEOUT",
      "EXTERNAL",
      "INTERNAL",
    ] as const;
    for (const code of codes) {
      assertKoiError({ code, message: "test", retryable: false });
    }
  });

  test("validates expected code", () => {
    assertKoiError({ code: "TIMEOUT", message: "slow", retryable: true }, { code: "TIMEOUT" });
  });

  test("validates expected retryable", () => {
    assertKoiError(
      { code: "RATE_LIMIT", message: "throttled", retryable: true },
      { retryable: true },
    );
  });

  test("validates both code and retryable", () => {
    assertKoiError(
      { code: "CONFLICT", message: "exists", retryable: true },
      { code: "CONFLICT", retryable: true },
    );
  });

  test("throws for invalid code", () => {
    expect(() => assertKoiError({ code: "UNKNOWN", message: "bad", retryable: false })).toThrow();
  });

  test("throws for missing message", () => {
    expect(() => assertKoiError({ code: "INTERNAL", retryable: false })).toThrow();
  });

  test("throws for empty message", () => {
    expect(() => assertKoiError({ code: "INTERNAL", message: "", retryable: false })).toThrow();
  });

  test("throws for undefined input", () => {
    expect(() => assertKoiError(undefined)).toThrow();
  });

  test("throws for null input", () => {
    expect(() => assertKoiError(null)).toThrow();
  });

  test("throws for mismatched code", () => {
    expect(() =>
      assertKoiError({ code: "TIMEOUT", message: "slow", retryable: true }, { code: "INTERNAL" }),
    ).toThrow();
  });

  test("throws for mismatched retryable", () => {
    expect(() =>
      assertKoiError({ code: "INTERNAL", message: "fail", retryable: false }, { retryable: true }),
    ).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import type { KoiError, KoiErrorCode } from "@koi/core";
import { formatErrorForChannel } from "./format-error.js";

function makeError(code: KoiErrorCode, message = `${code} error`, retryAfterMs?: number): KoiError {
  return {
    code,
    message,
    retryable: false,
    ...(retryAfterMs !== undefined && { retryAfterMs }),
  };
}

describe("formatErrorForChannel", () => {
  describe("default (non-verbose) mode", () => {
    test("VALIDATION returns prefixed original message", () => {
      const result = formatErrorForChannel(makeError("VALIDATION", "email is required"));
      expect(result).toBe("Invalid input: email is required");
    });

    test("NOT_FOUND returns user-friendly message", () => {
      expect(formatErrorForChannel(makeError("NOT_FOUND"))).toBe(
        "The requested resource was not found.",
      );
    });

    test("PERMISSION returns user-friendly message", () => {
      expect(formatErrorForChannel(makeError("PERMISSION"))).toBe(
        "You don't have permission to perform this action.",
      );
    });

    test("CONFLICT returns user-friendly message", () => {
      expect(formatErrorForChannel(makeError("CONFLICT"))).toBe(
        "A conflict occurred. Please try again.",
      );
    });

    test("RATE_LIMIT returns user-friendly message", () => {
      expect(formatErrorForChannel(makeError("RATE_LIMIT"))).toBe(
        "Too many requests. Please wait a moment.",
      );
    });

    test("TIMEOUT returns user-friendly message", () => {
      expect(formatErrorForChannel(makeError("TIMEOUT"))).toBe(
        "The operation timed out. Please try again.",
      );
    });

    test("EXTERNAL returns user-friendly message", () => {
      expect(formatErrorForChannel(makeError("EXTERNAL"))).toBe(
        "An external service is temporarily unavailable.",
      );
    });

    test("INTERNAL returns user-friendly message", () => {
      expect(formatErrorForChannel(makeError("INTERNAL"))).toBe(
        "Something went wrong. Please try again later.",
      );
    });
  });

  describe("verbose mode", () => {
    const verbose = { verbose: true } as const;

    test("VALIDATION returns prefixed original message (same as non-verbose)", () => {
      const result = formatErrorForChannel(makeError("VALIDATION", "name too long"), verbose);
      expect(result).toBe("Invalid input: name too long");
    });

    test("NOT_FOUND appends technical message", () => {
      expect(formatErrorForChannel(makeError("NOT_FOUND", "agent xyz missing"), verbose)).toBe(
        "The requested resource was not found. (agent xyz missing)",
      );
    });

    test("PERMISSION appends technical message", () => {
      expect(formatErrorForChannel(makeError("PERMISSION", "scope denied"), verbose)).toBe(
        "You don't have permission to perform this action. (scope denied)",
      );
    });

    test("CONFLICT appends technical message", () => {
      expect(formatErrorForChannel(makeError("CONFLICT", "version mismatch"), verbose)).toBe(
        "A conflict occurred. Please try again. (version mismatch)",
      );
    });

    test("RATE_LIMIT with retryAfterMs shows retry hint", () => {
      expect(formatErrorForChannel(makeError("RATE_LIMIT", "too fast", 5000), verbose)).toBe(
        "Too many requests. Please wait a moment. (retry after 5000ms)",
      );
    });

    test("RATE_LIMIT without retryAfterMs falls back to technical message", () => {
      expect(formatErrorForChannel(makeError("RATE_LIMIT", "429 received"), verbose)).toBe(
        "Too many requests. Please wait a moment. (429 received)",
      );
    });

    test("TIMEOUT appends technical message", () => {
      expect(formatErrorForChannel(makeError("TIMEOUT", "30s exceeded"), verbose)).toBe(
        "The operation timed out. Please try again. (30s exceeded)",
      );
    });

    test("EXTERNAL appends technical message", () => {
      expect(formatErrorForChannel(makeError("EXTERNAL", "API 503"), verbose)).toBe(
        "An external service is temporarily unavailable. (API 503)",
      );
    });

    test("INTERNAL appends technical message", () => {
      expect(formatErrorForChannel(makeError("INTERNAL", "null ref"), verbose)).toBe(
        "Something went wrong. Please try again later. (null ref)",
      );
    });
  });

  test("undefined options defaults to non-verbose", () => {
    const result = formatErrorForChannel(makeError("INTERNAL", "secret details"));
    expect(result).toBe("Something went wrong. Please try again later.");
    expect(result).not.toContain("secret details");
  });
});

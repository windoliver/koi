import { describe, expect, it } from "bun:test";
import type { KoiError } from "@koi/core";
import { formatErrorForChannel } from "./format-error.js";

const baseError = (code: KoiError["code"], message: string, extra?: Partial<KoiError>): KoiError =>
  ({
    code,
    message,
    retryable: false,
    ...extra,
  }) satisfies KoiError;

describe("formatErrorForChannel", () => {
  it("uses original message for VALIDATION", () => {
    const err = baseError("VALIDATION", "field 'x' is required");
    expect(formatErrorForChannel(err)).toBe("Invalid input: field 'x' is required");
  });

  it("returns canned message for NOT_FOUND", () => {
    const err = baseError("NOT_FOUND", "user 123 missing");
    expect(formatErrorForChannel(err)).toBe("The requested resource was not found.");
  });

  it("returns canned message for PERMISSION", () => {
    expect(formatErrorForChannel(baseError("PERMISSION", "denied"))).toBe(
      "You don't have permission to perform this action.",
    );
  });

  it("returns canned message for RATE_LIMIT", () => {
    expect(formatErrorForChannel(baseError("RATE_LIMIT", "throttled"))).toBe(
      "Too many requests. Please wait a moment.",
    );
  });

  it("returns canned message for TIMEOUT", () => {
    expect(formatErrorForChannel(baseError("TIMEOUT", "took too long"))).toBe(
      "The operation timed out. Please try again.",
    );
  });

  it("returns canned message for EXTERNAL", () => {
    expect(formatErrorForChannel(baseError("EXTERNAL", "upstream 503"))).toBe(
      "An external service is temporarily unavailable.",
    );
  });

  it("returns canned message for INTERNAL", () => {
    expect(formatErrorForChannel(baseError("INTERNAL", "boom"))).toBe(
      "Something went wrong. Please try again later.",
    );
  });

  it("returns canned message for STALE_REF", () => {
    expect(formatErrorForChannel(baseError("STALE_REF", "ref invalidated"))).toBe(
      "The referenced element is no longer valid. Please try again.",
    );
  });

  it("returns canned message for AUTH_REQUIRED", () => {
    expect(formatErrorForChannel(baseError("AUTH_REQUIRED", "oauth needed"))).toBe(
      "Authorization is required to continue.",
    );
  });

  it("returns canned message for RESOURCE_EXHAUSTED", () => {
    expect(formatErrorForChannel(baseError("RESOURCE_EXHAUSTED", "no slots"))).toBe(
      "Capacity limit reached. Please try again shortly.",
    );
  });

  it("returns canned message for UNAVAILABLE", () => {
    expect(formatErrorForChannel(baseError("UNAVAILABLE", "no backend"))).toBe(
      "The service is currently unavailable.",
    );
  });

  it("returns canned message for CONFLICT", () => {
    expect(formatErrorForChannel(baseError("CONFLICT", "version mismatch"))).toBe(
      "A conflict occurred. Please try again.",
    );
  });

  it("returns canned message for HEARTBEAT_TIMEOUT", () => {
    expect(formatErrorForChannel(baseError("HEARTBEAT_TIMEOUT", "no beat"))).toBe(
      "The worker stopped responding.",
    );
  });

  describe("safety: non-VALIDATION codes never leak raw message", () => {
    it("INTERNAL output omits the raw message", () => {
      const err = baseError("INTERNAL", "boom-internal-detail");
      expect(formatErrorForChannel(err)).toBe("Something went wrong. Please try again later.");
      expect(formatErrorForChannel(err)).not.toContain("boom-internal-detail");
    });

    it("RATE_LIMIT output omits retryAfterMs and raw message", () => {
      const err = baseError("RATE_LIMIT", "throttled", { retryAfterMs: 5_000 });
      const out = formatErrorForChannel(err);
      expect(out).toBe("Too many requests. Please wait a moment.");
      expect(out).not.toContain("5000");
      expect(out).not.toContain("throttled");
    });
  });

  describe("safety", () => {
    it("never includes cause", () => {
      const err = baseError("INTERNAL", "boom", { cause: new Error("secret stack trace") });
      const output = formatErrorForChannel(err);
      expect(output).not.toContain("secret stack trace");
    });

    it("never includes context", () => {
      const err = baseError("NOT_FOUND", "missing", {
        context: { userId: "secret-user-id" },
      });
      const output = formatErrorForChannel(err);
      expect(output).not.toContain("secret-user-id");
    });
  });
});

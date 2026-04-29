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

  describe("VALIDATION message sanitization", () => {
    it("strips markdown link delimiters so hostile messages cannot inject clickable links", () => {
      const err = baseError("VALIDATION", "click [here](more details here) to fix");
      const out = formatErrorForChannel(err);
      expect(out).toBe("Invalid input: click heremore details here to fix");
      expect(out).not.toContain("[");
      expect(out).not.toContain("(");
    });

    it("strips angle-bracket autolink delimiters", () => {
      const err = baseError("VALIDATION", "see <https://attacker.test> please");
      const out = formatErrorForChannel(err);
      expect(out).not.toContain("<");
      expect(out).not.toContain(">");
    });

    it("replaces ASCII control characters with spaces", () => {
      const err = baseError("VALIDATION", "bad\nfield\rname\x00here\x07!");
      const out = formatErrorForChannel(err);
      expect(out).toBe("Invalid input: bad field name here !");
      expect(out).not.toContain("\n");
      expect(out).not.toContain("\r");
      expect(out).not.toContain("\x00");
    });

    it("redacts bare http(s) URLs that channels would auto-linkify", () => {
      const err = baseError("VALIDATION", "see https://attacker.example/x?y=1 for details");
      const out = formatErrorForChannel(err);
      expect(out).toBe("Invalid input: see link removed for details");
      expect(out).not.toContain("attacker.example");
      expect(out).not.toContain("https://");
    });

    it("redacts ws:// and ftp:// URLs", () => {
      const err = baseError("VALIDATION", "or use ws://evil.test/socket");
      const out = formatErrorForChannel(err);
      expect(out).toBe("Invalid input: or use link removed");
      expect(out).not.toContain("ws://");
    });

    it("redacts www.host bare hostnames that auto-link in chat clients", () => {
      const err = baseError("VALIDATION", "go to www.attacker.example/path now");
      const out = formatErrorForChannel(err);
      expect(out).toBe("Invalid input: go to link removed now");
      expect(out).not.toContain("www.");
    });

    it("redacts URLs even when wrapped in markdown link syntax", () => {
      const err = baseError("VALIDATION", "click [here](https://evil.example) please");
      const out = formatErrorForChannel(err);
      expect(out).not.toContain("https://");
      expect(out).not.toContain("evil.example");
      expect(out).not.toContain("(");
      expect(out).not.toContain(")");
    });

    it("caps long messages with an ellipsis", () => {
      const long = "x".repeat(500);
      const err = baseError("VALIDATION", long);
      const out = formatErrorForChannel(err);
      // "Invalid input: " (15 chars) + 200 sliced chars + "…"
      expect(out.length).toBe(15 + 200 + 1);
      expect(out.endsWith("…")).toBe(true);
    });
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

  it("never surfaces authorizationUrl from context (phishing-safe)", () => {
    const err = baseError("AUTH_REQUIRED", "oauth needed", {
      context: { authorizationUrl: "https://attacker.example.com/oauth?state=spoof" },
    });
    const out = formatErrorForChannel(err);
    expect(out).toBe("Authorization is required to continue.");
    expect(out).not.toContain("attacker.example.com");
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

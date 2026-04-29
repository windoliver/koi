import { describe, expect, it } from "bun:test";
import type { KoiError } from "@koi/core";
import { formatErrorForChannel, formatErrorTextForChannel } from "./format-error.js";

const baseError = (code: KoiError["code"], message: string, extra?: Partial<KoiError>): KoiError =>
  ({
    code,
    message,
    retryable: false,
    ...extra,
  }) satisfies KoiError;

describe("formatErrorForChannel discriminated output", () => {
  it("returns kind:'validation' with safeText and rawMessage for VALIDATION", () => {
    const err = baseError("VALIDATION", "field 'x' is required");
    const out = formatErrorForChannel(err);
    expect(out).toEqual({
      kind: "validation",
      safeText: "Invalid input: field 'x' is required",
      rawMessage: "field 'x' is required",
    });
  });

  it("returns kind:'auth-required' with the original error for AUTH_REQUIRED", () => {
    const err = baseError("AUTH_REQUIRED", "oauth needed", {
      context: { authorizationUrl: "https://issuer.example/oauth" },
    });
    const out = formatErrorForChannel(err);
    expect(out.kind).toBe("auth-required");
    if (out.kind === "auth-required") {
      expect(out.safeText).toBe("Authorization is required to continue.");
      expect(out.error).toBe(err);
    }
  });

  it("returns kind:'text' with canned message for everything else", () => {
    expect(formatErrorForChannel(baseError("NOT_FOUND", "x"))).toEqual({
      kind: "text",
      text: "The requested resource was not found.",
    });
    expect(formatErrorForChannel(baseError("RATE_LIMIT", "x"))).toEqual({
      kind: "text",
      text: "Too many requests. Please wait a moment.",
    });
  });

  describe("VALIDATION sanitization (delivered via safeText)", () => {
    const safeText = (msg: string): string => {
      const out = formatErrorForChannel(baseError("VALIDATION", msg));
      if (out.kind !== "validation") throw new Error("expected validation kind");
      return out.safeText;
    };

    it("strips markdown link delimiters", () => {
      const out = safeText("click [here](more details here) to fix");
      expect(out).toBe("Invalid input: click heremore details here to fix");
      expect(out).not.toContain("[");
      expect(out).not.toContain("(");
    });

    it("redacts http(s)/ws/ftp URLs", () => {
      expect(safeText("see https://attacker.example/x for details")).toBe(
        "Invalid input: see link removed for details",
      );
      expect(safeText("or use ws://evil.test/socket")).toBe("Invalid input: or use link removed");
    });

    it("redacts www.host bare hostnames", () => {
      expect(safeText("go to www.attacker.example/path now")).toBe(
        "Invalid input: go to link removed now",
      );
    });

    it("replaces ASCII control characters with spaces", () => {
      const out = safeText("bad\nfield\rname\x00here\x07!");
      expect(out).toBe("Invalid input: bad field name here !");
    });

    it("caps long messages with an ellipsis", () => {
      const out = safeText("x".repeat(500));
      expect(out.length).toBe(15 + 200 + 1);
      expect(out.endsWith("…")).toBe(true);
    });

    it("preserves rawMessage even when safeText is sanitized", () => {
      const raw = "click [here](https://evil.example) please";
      const out = formatErrorForChannel(baseError("VALIDATION", raw));
      if (out.kind !== "validation") throw new Error("expected validation kind");
      expect(out.rawMessage).toBe(raw);
      expect(out.safeText).not.toContain("https://");
    });
  });

  describe("AUTH_REQUIRED hands off to adapter for trust validation", () => {
    it("safeText never contains URL even when error.context has one", () => {
      const err = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "https://attacker.example/spoof" },
      });
      const out = formatErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.safeText).toBe("Authorization is required to continue.");
      expect(out.safeText).not.toContain("attacker.example");
    });

    it("delivers the original error so the adapter can read context", () => {
      const err = baseError("AUTH_REQUIRED", "oauth needed", {
        context: { authorizationUrl: "https://issuer.example", scope: "read" },
      });
      const out = formatErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.error.context).toEqual({
        authorizationUrl: "https://issuer.example",
        scope: "read",
      });
    });
  });

  describe("safety: non-VALIDATION codes never leak raw message", () => {
    it("INTERNAL output omits the raw message", () => {
      const err = baseError("INTERNAL", "boom-internal-detail");
      const out = formatErrorForChannel(err);
      expect(out).toEqual({
        kind: "text",
        text: "Something went wrong. Please try again later.",
      });
    });

    it("RATE_LIMIT output omits retryAfterMs and raw message", () => {
      const err = baseError("RATE_LIMIT", "throttled", { retryAfterMs: 5_000 });
      const out = formatErrorForChannel(err);
      if (out.kind !== "text") throw new Error("expected text kind");
      expect(out.text).toBe("Too many requests. Please wait a moment.");
      expect(out.text).not.toContain("5000");
      expect(out.text).not.toContain("throttled");
    });

    it("never includes cause", () => {
      const err = baseError("INTERNAL", "boom", { cause: new Error("secret stack trace") });
      const out = formatErrorForChannel(err);
      if (out.kind !== "text") throw new Error("expected text kind");
      expect(out.text).not.toContain("secret stack trace");
    });

    it("never includes context for non-AUTH codes", () => {
      const err = baseError("NOT_FOUND", "missing", {
        context: { userId: "secret-user-id" },
      });
      const out = formatErrorForChannel(err);
      if (out.kind !== "text") throw new Error("expected text kind");
      expect(out.text).not.toContain("secret-user-id");
    });
  });
});

describe("formatErrorTextForChannel collapse helper", () => {
  it("returns canned text for plain codes", () => {
    expect(formatErrorTextForChannel(baseError("NOT_FOUND", "x"))).toBe(
      "The requested resource was not found.",
    );
    expect(formatErrorTextForChannel(baseError("PERMISSION", "x"))).toBe(
      "You don't have permission to perform this action.",
    );
    expect(formatErrorTextForChannel(baseError("CONFLICT", "x"))).toBe(
      "A conflict occurred. Please try again.",
    );
    expect(formatErrorTextForChannel(baseError("TIMEOUT", "x"))).toBe(
      "The operation timed out. Please try again.",
    );
    expect(formatErrorTextForChannel(baseError("EXTERNAL", "x"))).toBe(
      "An external service is temporarily unavailable.",
    );
    expect(formatErrorTextForChannel(baseError("STALE_REF", "x"))).toBe(
      "The referenced element is no longer valid. Please try again.",
    );
    expect(formatErrorTextForChannel(baseError("RESOURCE_EXHAUSTED", "x"))).toBe(
      "Capacity limit reached. Please try again shortly.",
    );
    expect(formatErrorTextForChannel(baseError("UNAVAILABLE", "x"))).toBe(
      "The service is currently unavailable.",
    );
    expect(formatErrorTextForChannel(baseError("HEARTBEAT_TIMEOUT", "x"))).toBe(
      "The worker stopped responding.",
    );
  });

  it("returns sanitized validation safeText", () => {
    expect(formatErrorTextForChannel(baseError("VALIDATION", "field 'x' missing"))).toBe(
      "Invalid input: field 'x' missing",
    );
  });

  it("returns canned auth-required safeText (no URL leak)", () => {
    const err = baseError("AUTH_REQUIRED", "x", {
      context: { authorizationUrl: "https://attacker.example" },
    });
    expect(formatErrorTextForChannel(err)).toBe("Authorization is required to continue.");
  });
});

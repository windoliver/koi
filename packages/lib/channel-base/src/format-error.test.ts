import { describe, expect, it } from "bun:test";
import type { KoiError } from "@koi/core";
import { classifyErrorForChannel, formatErrorForChannel } from "./format-error.js";

const baseError = (code: KoiError["code"], message: string, extra?: Partial<KoiError>): KoiError =>
  ({
    code,
    message,
    retryable: false,
    ...extra,
  }) satisfies KoiError;

describe("classifyErrorForChannel discriminated output", () => {
  it("returns kind:'validation' with sanitized safeText for VALIDATION", () => {
    const err = baseError("VALIDATION", "field 'x' is required");
    const out = classifyErrorForChannel(err);
    expect(out).toEqual({
      kind: "validation",
      safeText: "Invalid input: field 'x' is required",
    });
  });

  it("returns kind:'auth-required' with narrowed auth handoff for AUTH_REQUIRED", () => {
    const err = baseError("AUTH_REQUIRED", "oauth needed", {
      context: { authorizationUrl: "https://issuer.example/oauth" },
    });
    const out = classifyErrorForChannel(err);
    expect(out.kind).toBe("auth-required");
    if (out.kind === "auth-required") {
      expect(out.safeText).toBe("Authorization is required to continue.");
      expect(out.auth.unverifiedAuthorizationUrl).toBe("https://issuer.example/oauth");
    }
  });

  it("returns kind:'text' with canned message for everything else", () => {
    expect(classifyErrorForChannel(baseError("NOT_FOUND", "x"))).toEqual({
      kind: "text",
      text: "The requested resource was not found.",
    });
    expect(classifyErrorForChannel(baseError("RATE_LIMIT", "x"))).toEqual({
      kind: "text",
      text: "Too many requests. Please wait a moment.",
    });
  });

  describe("VALIDATION sanitization (delivered via safeText)", () => {
    const safeText = (msg: string): string => {
      const out = classifyErrorForChannel(baseError("VALIDATION", msg));
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

    it("redacts non-http URI schemes that autolink or trigger client actions", () => {
      // Regression: loop-5 round 3 finding 3. mailto:, file:, slack:,
      // vscode:, sms:, tel:, data:, javascript:, custom app:// schemes
      // all autolink or trigger client actions on common transports.
      // The sanitizer's plain-text contract requires deny-by-default.
      expect(safeText("contact mailto:attacker@example.com now")).toBe(
        "Invalid input: contact link removed now",
      );
      expect(safeText("open file:///etc/passwd")).toBe("Invalid input: open link removed");
      expect(safeText("see slack://channel?team=evil")).toBe("Invalid input: see link removed");
      expect(safeText("run vscode://settings/edit")).toBe("Invalid input: run link removed");
      expect(safeText("dial tel:+15551234567")).toBe("Invalid input: dial link removed");
      expect(safeText("view data:text/html,<x>")).toBe("Invalid input: view link removed");
      expect(safeText("javascript:alert(1)")).toBe("Invalid input: link removed");
    });

    it("redacts www.host bare hostnames", () => {
      expect(safeText("go to www.attacker.example/path now")).toBe(
        "Invalid input: go to link removed now",
      );
    });

    it("redacts schemeless bare domains that include a URL marker (path/port/query/fragment)", () => {
      // Loop-5 round 7: the bare-domain pattern must require a trailing
      // URL marker to avoid eating dotted identifiers in validation
      // messages (`user.profile.email`, `payload.items[0].sku`). With
      // a marker it still catches autolink-grade strings.
      expect(safeText("visit evil.example/pay now")).toBe("Invalid input: visit link removed now");
      expect(safeText("see attacker.co.uk/path")).toBe("Invalid input: see link removed");
    });

    it("preserves dotted identifiers commonly used in validation messages", () => {
      // Regression: loop-5 round 7 finding 2. Recovery info must survive.
      expect(safeText("field 'user.profile.email' is required")).toBe(
        "Invalid input: field 'user.profile.email' is required",
      );
      expect(safeText("invalid value at config.http.timeout")).toBe(
        "Invalid input: invalid value at config.http.timeout",
      );
    });

    it("replaces ASCII control characters with spaces", () => {
      const out = safeText("bad\nfield\rname\x00here\x07end");
      expect(out).toBe("Invalid input: bad field name here end");
    });

    it("caps long messages with an ellipsis", () => {
      const out = safeText("x".repeat(500));
      expect(out.length).toBe(15 + 200 + 1);
      expect(out.endsWith("…")).toBe(true);
    });

    it("strips @mentions so hostile text cannot trigger mass-notification", () => {
      expect(safeText("invalid @everyone please fix")).toBe(
        "Invalid input: invalid everyone please fix",
      );
      expect(safeText("ping @channel")).not.toContain("@");
    });

    it("strips backticks and emphasis markers (markdown formatting)", () => {
      const out = safeText("nope `code` *bold* _under_ ~strike~");
      expect(out).toBe("Invalid input: nope code bold under strike");
      expect(out).not.toMatch(/[`*_~]/);
    });

    it("strips Unicode bidi/format/zero-width controls", () => {
      // ZWSP / RLO / LRO / PDF / ZWJ — invisible characters often used to
      // hide or reorder text in chat/HTML surfaces.
      const out = safeText("safe​‮txet‬‍word");
      expect(out).toBe("Invalid input: safetxetword");
      expect(out).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/);
    });

    it("strips header, table, image, escape, and entity sigils", () => {
      const out = safeText("# header | cell ! image &amp; \\escape");
      expect(out).not.toMatch(/[#|!&\\]/);
    });

    it("does not expose raw error.message back to the adapter", () => {
      const raw = "click [here](https://evil.example) please";
      const out = classifyErrorForChannel(baseError("VALIDATION", raw));
      if (out.kind !== "validation") throw new Error("expected validation kind");
      expect(out).not.toHaveProperty("rawMessage");
      expect(out.safeText).not.toContain("https://");
    });
  });

  describe("AUTH_REQUIRED hands off to adapter for trust validation", () => {
    it("safeText never contains URL even when error.context has one", () => {
      const err = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "https://attacker.example/spoof" },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.safeText).toBe("Authorization is required to continue.");
      expect(out.safeText).not.toContain("attacker.example");
    });

    it("delivers a narrowed auth handoff with only candidate-safe fields", () => {
      const err = baseError("AUTH_REQUIRED", "oauth needed", {
        context: { authorizationUrl: "https://issuer.example", scope: "read" },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth).toEqual({
        // URL is canonicalized via the URL constructor.
        unverifiedAuthorizationUrl: "https://issuer.example/",
        scope: "read",
      });
    });

    it("does not expose error.message, cause, or unrelated context fields", () => {
      const err = baseError("AUTH_REQUIRED", "secret-internal-message", {
        context: {
          authorizationUrl: "https://issuer.example",
          userId: "secret-user",
          internalToken: "secret-token",
        },
        cause: new Error("secret stack trace"),
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("secret-internal-message");
      expect(serialized).not.toContain("secret-user");
      expect(serialized).not.toContain("secret-token");
      expect(serialized).not.toContain("secret stack trace");
      // No raw `error` field on the discriminant — only `auth` is exposed.
      expect(out).not.toHaveProperty("error");
    });

    it("normalizes the authorization URL and rejects unsafe schemes", () => {
      // javascript: scheme is dropped — never expose an XSS-risky link.
      const xss = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "javascript:alert(1)" },
      });
      const xssOut = classifyErrorForChannel(xss);
      if (xssOut.kind !== "auth-required") throw new Error("expected auth-required");
      expect(xssOut.auth.unverifiedAuthorizationUrl).toBeUndefined();

      // data: scheme is dropped.
      const dataUrl = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "data:text/html,<script>alert(1)</script>" },
      });
      const dataOut = classifyErrorForChannel(dataUrl);
      if (dataOut.kind !== "auth-required") throw new Error("expected auth-required");
      expect(dataOut.auth.unverifiedAuthorizationUrl).toBeUndefined();

      // ftp scheme is dropped.
      const ftp = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "ftp://issuer.example/auth" },
      });
      const ftpOut = classifyErrorForChannel(ftp);
      if (ftpOut.kind !== "auth-required") throw new Error("expected auth-required");
      expect(ftpOut.auth.unverifiedAuthorizationUrl).toBeUndefined();

      // http: rejected — cleartext OAuth handoff exposes credentials.
      const http = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "http://issuer.example/auth" },
      });
      const httpOut = classifyErrorForChannel(http);
      if (httpOut.kind !== "auth-required") throw new Error("expected auth-required");
      expect(httpOut.auth.unverifiedAuthorizationUrl).toBeUndefined();
    });

    it("rejects authorization URLs with embedded userinfo (credential leak / phishing)", () => {
      // user:pass@host — credentials leak risk via logs/UX.
      const withCreds = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "https://user:pass@issuer.example/auth" },
      });
      const credsOut = classifyErrorForChannel(withCreds);
      if (credsOut.kind !== "auth-required") throw new Error("expected auth-required");
      expect(credsOut.auth.unverifiedAuthorizationUrl).toBeUndefined();

      // trusted.example@attacker.test — classic phishing: a naive
      // host-prefix check matches the userinfo, not the real host.
      const phish = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "https://trusted.example@attacker.test/auth" },
      });
      const phishOut = classifyErrorForChannel(phish);
      if (phishOut.kind !== "auth-required") throw new Error("expected auth-required");
      expect(phishOut.auth.unverifiedAuthorizationUrl).toBeUndefined();
    });

    it("strips control/bidi chars from the authorization URL before parsing", () => {
      // Inject a bidi (RLO U+202E) and a null byte into the URL string.
      const hostile = `https://issuer.example/oauth‮ `;
      const err = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: hostile },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth.unverifiedAuthorizationUrl).toBeDefined();
      // No bidi/control chars remain on the way out.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: testing strip behavior
      expect(out.auth.unverifiedAuthorizationUrl).not.toMatch(/\u202E/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: testing strip behavior
      expect(out.auth.unverifiedAuthorizationUrl).not.toMatch(/\x00/);
    });

    it("rejects malformed authorization URLs", () => {
      const malformed = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: "not a url" },
      });
      const out = classifyErrorForChannel(malformed);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth.unverifiedAuthorizationUrl).toBeUndefined();
    });

    it("rejects oversized authorization URLs", () => {
      const oversized = baseError("AUTH_REQUIRED", "x", {
        context: { authorizationUrl: `https://issuer.example/${"a".repeat(3000)}` },
      });
      const out = classifyErrorForChannel(oversized);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth.unverifiedAuthorizationUrl).toBeUndefined();
    });

    it("preserves URI-shaped OAuth scopes (informed consent)", () => {
      // Real OAuth scopes are often URI-shaped — Google, Microsoft, AWS
      // STS, etc. The sanitizer must NOT strip them.
      const err = baseError("AUTH_REQUIRED", "x", {
        context: {
          authorizationUrl: "https://issuer.example",
          scope: "https://www.googleapis.com/auth/drive.readonly api://resource/.default",
        },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth.scope).toBe(
        "https://www.googleapis.com/auth/drive.readonly api://resource/.default",
      );
    });

    it("strips control/bidi chars from auth scope (still rejects hostile invisible input)", () => {
      const err = baseError("AUTH_REQUIRED", "x", {
        context: {
          authorizationUrl: "https://issuer.example",
          scope: "drive\nread\x00‮hidden",
        },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth.scope).toBeDefined();
      // biome-ignore lint/suspicious/noControlCharactersInRegex: testing strip behavior
      expect(out.auth.scope).not.toMatch(/[\x00-\x1f]/);
      expect(out.auth.scope).not.toMatch(/‮/);
    });

    it("omits oversized auth scope entirely (all-or-nothing consent UX)", () => {
      // Regression: loop-5 round 5 finding 1. Truncating the scope list
      // misleads consent UX — the user may approve broader access than
      // what the channel displayed. If the full validated list would
      // exceed the cap, omit scope entirely so adapters fall back to
      // generic auth handoff text.
      const err = baseError("AUTH_REQUIRED", "x", {
        context: {
          authorizationUrl: "https://issuer.example",
          scope: "x".repeat(500),
        },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth.scope).toBeUndefined();
    });

    it("omits scope when ANY token fails validation (no partial display)", () => {
      // Regression: loop-5 round 5. Mixed valid/invalid tokens must
      // never produce a misleading subset. Drop the whole field.
      const err = baseError("AUTH_REQUIRED", "x", {
        context: {
          authorizationUrl: "https://issuer.example",
          scope: "drive.readonly @everyone email",
        },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth.scope).toBeUndefined();
    });

    it("returns an empty auth object when context has no candidate-safe fields", () => {
      const err = baseError("AUTH_REQUIRED", "x", {
        context: { unrelated: "value" },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "auth-required") throw new Error("expected auth-required");
      expect(out.auth).toEqual({});
    });
  });

  describe("forward-compatibility for unknown error codes", () => {
    it("returns a generic safe message for unrecognized codes (version skew)", () => {
      const futureError = {
        code: "BRAND_NEW_FUTURE_CODE",
        message: "from a newer producer",
        retryable: false,
      } as unknown as KoiError;
      const out = classifyErrorForChannel(futureError);
      expect(out).toEqual({
        kind: "text",
        text: "Something went wrong. Please try again later.",
      });
    });

    it("formatErrorForChannel never returns undefined for unknown codes", () => {
      const futureError = {
        code: "SOMETHING_NEW",
        message: "x",
        retryable: false,
      } as unknown as KoiError;
      const text = formatErrorForChannel(futureError);
      expect(typeof text).toBe("string");
      expect(text.length).toBeGreaterThan(0);
    });
  });

  describe("safety: non-VALIDATION codes never leak raw message", () => {
    it("INTERNAL output omits the raw message", () => {
      const err = baseError("INTERNAL", "boom-internal-detail");
      const out = classifyErrorForChannel(err);
      expect(out).toEqual({
        kind: "text",
        text: "Something went wrong. Please try again later.",
      });
    });

    it("RATE_LIMIT output omits retryAfterMs and raw message", () => {
      const err = baseError("RATE_LIMIT", "throttled", { retryAfterMs: 5_000 });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "text") throw new Error("expected text kind");
      expect(out.text).toBe("Too many requests. Please wait a moment.");
      expect(out.text).not.toContain("5000");
      expect(out.text).not.toContain("throttled");
    });

    it("never includes cause", () => {
      const err = baseError("INTERNAL", "boom", { cause: new Error("secret stack trace") });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "text") throw new Error("expected text kind");
      expect(out.text).not.toContain("secret stack trace");
    });

    it("never includes context for non-AUTH codes", () => {
      const err = baseError("NOT_FOUND", "missing", {
        context: { userId: "secret-user-id" },
      });
      const out = classifyErrorForChannel(err);
      if (out.kind !== "text") throw new Error("expected text kind");
      expect(out.text).not.toContain("secret-user-id");
    });
  });
});

describe("formatErrorForChannel collapse helper", () => {
  it("returns canned text for plain codes", () => {
    expect(formatErrorForChannel(baseError("NOT_FOUND", "x"))).toBe(
      "The requested resource was not found.",
    );
    expect(formatErrorForChannel(baseError("PERMISSION", "x"))).toBe(
      "You don't have permission to perform this action.",
    );
    expect(formatErrorForChannel(baseError("CONFLICT", "x"))).toBe(
      "A conflict occurred. Please try again.",
    );
    expect(formatErrorForChannel(baseError("TIMEOUT", "x"))).toBe(
      "The operation timed out. Please try again.",
    );
    expect(formatErrorForChannel(baseError("EXTERNAL", "x"))).toBe(
      "An external service is temporarily unavailable.",
    );
    expect(formatErrorForChannel(baseError("STALE_REF", "x"))).toBe(
      "The referenced element is no longer valid. Please try again.",
    );
    expect(formatErrorForChannel(baseError("RESOURCE_EXHAUSTED", "x"))).toBe(
      "Capacity limit reached. Please try again shortly.",
    );
    expect(formatErrorForChannel(baseError("UNAVAILABLE", "x"))).toBe(
      "The service is currently unavailable.",
    );
    expect(formatErrorForChannel(baseError("HEARTBEAT_TIMEOUT", "x"))).toBe(
      "The worker stopped responding.",
    );
  });

  it("returns sanitized validation safeText", () => {
    expect(formatErrorForChannel(baseError("VALIDATION", "field 'x' missing"))).toBe(
      "Invalid input: field 'x' missing",
    );
  });

  it("returns canned auth-required safeText (no URL leak)", () => {
    const err = baseError("AUTH_REQUIRED", "x", {
      context: { authorizationUrl: "https://attacker.example" },
    });
    expect(formatErrorForChannel(err)).toBe("Authorization is required to continue.");
  });
});

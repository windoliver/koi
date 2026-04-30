import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { KoiError } from "@koi/core";
import * as errors from "@koi/errors";
import { classifyErrorForChannel, formatErrorForChannel } from "./format-error.js";
import { createRateLimiter, type SendFn } from "./rate-limit.js";

/**
 * End-to-end integration tests for channel-base utilities, wiring
 * `createRateLimiter` and `formatErrorForChannel` together against a
 * fake transport. These cover scenarios the per-module unit tests
 * exercise in isolation but not in combination — the real channel
 * adapter call path.
 */
describe("channel-base integration: rate-limiter + formatErrorForChannel pipeline", () => {
  // biome-ignore lint/suspicious/noExplicitAny: spy type plumbing
  let sleepSpy: any;

  beforeEach(() => {
    sleepSpy = spyOn(errors, "sleep").mockImplementation(() => Promise.resolve());
  });

  afterEach(() => {
    sleepSpy.mockRestore();
  });

  // Helper: runs `enqueue(fn)` and pipes any rejection through
  // `formatErrorForChannel` exactly as a real channel adapter would.
  const sendThroughPipeline = async (
    limiter: ReturnType<typeof createRateLimiter>,
    fn: SendFn,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly userText: string }> => {
    try {
      await limiter.enqueue(fn);
      return { ok: true };
    } catch (e) {
      // The adapter receives a thrown value (real KoiError or synthetic).
      // It MUST get a user-safe string back from formatErrorForChannel,
      // never the raw error message.
      const koi: KoiError =
        typeof e === "object" && e !== null && "code" in e
          ? (e as KoiError)
          : { code: "INTERNAL", message: "unknown", retryable: false };
      return { ok: false, userText: formatErrorForChannel(koi) };
    }
  };

  it("hostile validation message thrown by transport: caller sees only canned-safe user text", async () => {
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
    });
    const hostileMessage =
      "click [here](https://evil.example/x?token=secret) " +
      "or contact mailto:hr@evil.example " +
      "or visit attacker.zip — *bold* `code` @everyone " +
      "​‮hidden‬";
    const fn: SendFn = () =>
      Promise.reject({
        code: "VALIDATION",
        message: hostileMessage,
        retryable: false,
      } satisfies KoiError);
    const result = await sendThroughPipeline(limiter, fn);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // No URL fragments survive.
    expect(result.userText).not.toContain("https://");
    expect(result.userText).not.toContain("evil.example");
    expect(result.userText).not.toContain("attacker.zip");
    expect(result.userText).not.toContain("mailto:");
    expect(result.userText).not.toContain("token=secret");
    expect(result.userText).not.toContain("hr@evil.example");
    // No formatting/mention/escape characters.
    expect(result.userText).not.toMatch(/[`*_~@#|!&\\[\]()<>{}]/);
    // No bidi or zero-width controls.
    expect(result.userText).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/u);
    // Does start with the canned prefix (proves classifyErrorForChannel ran).
    expect(result.userText.startsWith("Invalid input:")).toBe(true);
  });

  it("AUTH_REQUIRED with hostile context fields: handoff narrows to safe shape, scope drops if any token is suspect", async () => {
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
    });
    const fn: SendFn = () =>
      Promise.reject({
        code: "AUTH_REQUIRED",
        message: "internal-leak-secret",
        retryable: false,
        context: {
          authorizationUrl: "https://issuer.example/oauth",
          // Mix valid scopes with a hostile app-launch handoff.
          scope: "read User.Read zoommtg:join email",
          // Hostile internal fields — must NEVER leak.
          internalToken: "bearer-xyz",
          tenantSecret: "tenant-abc",
        },
        cause: new Error("internal stack trace"),
      } satisfies KoiError);
    try {
      await limiter.enqueue(fn);
      throw new Error("expected rejection");
    } catch (e) {
      const out = classifyErrorForChannel(e as KoiError);
      if (out.kind !== "auth-required") throw new Error(`expected auth-required, got ${out.kind}`);
      expect(out.auth.unverifiedAuthorizationUrl).toBe("https://issuer.example/oauth");
      // All-or-nothing: zoommtg:join trips the gate, whole scope dropped.
      expect(out.auth.scope).toBeUndefined();
      // Internal fields and stack must never appear.
      const serialized = JSON.stringify(out);
      expect(serialized).not.toContain("internalToken");
      expect(serialized).not.toContain("bearer-xyz");
      expect(serialized).not.toContain("tenantSecret");
      expect(serialized).not.toContain("tenant-abc");
      expect(serialized).not.toContain("internal-leak-secret");
      expect(serialized).not.toContain("internal stack trace");
    }
  });

  it("RATE_LIMIT with retryAfterMs: queue retries with the server cooldown, then surfaces canned safe text on exhaustion", async () => {
    const limiter = createRateLimiter({
      retry: {
        ...errors.DEFAULT_RETRY_CONFIG,
        maxRetries: 2,
        initialDelayMs: 5,
        jitter: false,
      },
    });
    let attempts = 0;
    const err: KoiError = {
      code: "RATE_LIMIT",
      message: "throttled-with-internal-host evil.example",
      retryable: true,
      retryAfterMs: 1000,
    };
    const fn: SendFn = () => {
      attempts++;
      return Promise.reject(err);
    };
    const result = await sendThroughPipeline(limiter, fn);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(attempts).toBe(3); // initial + 2 retries
    // Cooldown was honored on each backoff.
    expect(sleepSpy).toHaveBeenCalledWith(1000);
    // User text is canned, not the raw message containing "evil.example".
    expect(result.userText).toBe("Too many requests. Please wait a moment.");
    expect(result.userText).not.toContain("evil.example");
  });

  it("queue keeps draining after a hostile send rejects: subsequent sends see no leakage from prior errors", async () => {
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
    });
    const events: string[] = [];
    // First send rejects with a VALIDATION error containing a phishing host.
    const r1 = sendThroughPipeline(limiter, () =>
      Promise.reject({
        code: "VALIDATION",
        message: "field at user.profile.email — see https://evil.zip/x",
        retryable: false,
      } satisfies KoiError),
    );
    // Second send succeeds.
    const r2 = limiter.enqueue(async () => {
      events.push("ok-2");
    });
    // Third send rejects with INTERNAL.
    const r3 = sendThroughPipeline(limiter, () =>
      Promise.reject({
        code: "INTERNAL",
        message: "stack: at /usr/local/secret/path:42",
        retryable: false,
      } satisfies KoiError),
    );
    const [out1, _ok2, out3] = await Promise.all([r1, r2, r3]);
    if (out1.ok) throw new Error("expected r1 failure");
    if (out3.ok) throw new Error("expected r3 failure");
    expect(events).toEqual(["ok-2"]);
    // r1's safe text mentions invalid input but neither the host nor the
    // URL nor the dotted-domain phishing token survived.
    expect(out1.userText.startsWith("Invalid input:")).toBe(true);
    expect(out1.userText).not.toContain("https://");
    expect(out1.userText).not.toContain("evil.zip");
    // r3's safe text is canned — no internal path leaks.
    expect(out3.userText).toBe("Something went wrong. Please try again later.");
    expect(out3.userText).not.toContain("/usr/local");
    expect(out3.userText).not.toContain("secret");
  });

  it("partial KoiError shape from a JS adapter still flows through the formatter without throwing", async () => {
    // A real adapter may throw a plain `new Error(...)` whose `cause` is a
    // partial KoiError shape. The classifier should not require strict
    // KoiError typing — it must produce SOMETHING safe to render. The
    // pipeline helper above degrades to INTERNAL-canned in that case.
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
    });
    const fn: SendFn = () => Promise.reject(new Error("network broken"));
    const result = await sendThroughPipeline(limiter, fn);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    // Falls through to canned INTERNAL. Adapter never sees raw "network broken".
    expect(result.userText).toBe("Something went wrong. Please try again later.");
  });

  it("forward-compat: unknown error code from a future producer surfaces a generic safe message", async () => {
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
    });
    const fn: SendFn = () =>
      Promise.reject({
        code: "FUTURE_CODE_NOT_YET_KNOWN",
        message: "leaked-internal-detail",
        retryable: false,
        // biome-ignore lint/suspicious/noExplicitAny: simulating version-skew
      } as any);
    const result = await sendThroughPipeline(limiter, fn);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.userText).toBe("Something went wrong. Please try again later.");
    expect(result.userText).not.toContain("leaked-internal-detail");
  });

  it("synthetic TIMEOUT from rate-limiter watchdog: classifies as canned TIMEOUT (not the internal error message)", async () => {
    // The rate limiter's own deadline rejection IS a KoiError carrying
    // an internal phase context. End users must NOT see that internal
    // detail; classifyErrorForChannel must collapse it to canned text.
    const limiter = createRateLimiter({
      retry: { ...errors.DEFAULT_RETRY_CONFIG, maxRetries: 0 },
      sendTimeoutMs: 10,
    });
    // Transport that never settles — the watchdog will reject with synthetic TIMEOUT.
    const fn: SendFn = () => new Promise<void>(() => {});
    const result = await sendThroughPipeline(limiter, fn);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.userText).toBe("The operation timed out. Please try again.");
    // Internal phase string (e.g. "deadline-exceeded", "delivery-unknown") must NOT leak.
    expect(result.userText).not.toContain("phase");
    expect(result.userText).not.toContain("deadline");
    expect(result.userText).not.toContain("delivery-unknown");
    expect(result.userText).not.toContain("transport");
  });
});

/**
 * Property-style fuzz: feed many randomly-generated inputs through
 * `sanitizeValidationMessage` (via classifyErrorForChannel) and assert
 * invariants on the output. Catches whole classes of regex-bypass bugs
 * the explicit cases miss.
 */
describe("channel-base integration: sanitizer fuzz invariants", () => {
  // Tokens drawn from a wide character pool — ASCII letters, digits,
  // formatting sigils, scheme-shapes, punycode, IDN, control chars,
  // dotted/colon hosts, fragments, paths, etc.
  const POOL = [
    // ASCII identifiers / words
    "field",
    "user",
    "profile",
    "email",
    "config",
    "timeout",
    "items",
    "value",
    // Real domain shapes
    "evil.com",
    "attacker.io/pay",
    "phish.co.uk/path",
    "login.company.com",
    // Novel TLDs
    "evil.zip",
    "login.support",
    "attacker.mov",
    "scam.travel",
    "x.health",
    // 3+ label phishing
    "login.attacker.email",
    "cdn.bad.info",
    "login.company.careers",
    "auth.example.travel",
    // URL-shapes
    "https://evil.example/x",
    "http://evil.example",
    "ws://evil.test/socket",
    "mailto:attacker@evil.example",
    "javascript:alert(1)",
    "vscode://settings",
    "data:text/html,<x>",
    "file:///etc/passwd",
    "tel:+15551234567",
    // www.
    "www.attacker.example/path",
    // IDN / Unicode
    "例子.测试",
    "аpple.com",
    "xn--mxn-bla.test",
    "googlé.com/search",
    // Identifier paths
    "user.profile.email",
    "config.http.timeout",
    "users[0].email_address",
    "payload.items[0].sku",
    // Markdown
    "[here](more)",
    "_under_",
    "*bold*",
    "`code`",
    "~strike~",
    "@everyone",
    "@channel",
    "# header",
    "| cell",
    "&amp;",
    "\\escape",
    // Control / bidi
    "\x00\x01\x07\x1f\x7f",
    "​‌‏",
    "‪‮",
    "⁦⁩",
    "﻿",
    // Plain noise
    "hello",
    "world",
    "  ",
    "",
  ];

  // Deterministic LCG for reproducibility.
  const seededRng = (seed: number): (() => number) => {
    let state = seed >>> 0;
    return (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  };

  const safeText = (msg: string): string => {
    const out = classifyErrorForChannel({ code: "VALIDATION", message: msg, retryable: false });
    if (out.kind !== "validation") throw new Error("expected validation");
    return out.safeText;
  };

  const ITERATIONS = 500;

  it(`for ${ITERATIONS} random validation messages: output never contains a clickable URL fragment`, () => {
    const rng = seededRng(0xc0ffee);
    for (let i = 0; i < ITERATIONS; i++) {
      const tokenCount = 1 + Math.floor(rng() * 8);
      const parts: string[] = [];
      for (let j = 0; j < tokenCount; j++) {
        const idx = Math.floor(rng() * POOL.length);
        parts.push(POOL[idx] ?? "");
      }
      const msg = parts.join(rng() < 0.5 ? " " : "");
      const out = safeText(msg);
      // URL/scheme markers
      expect(out).not.toContain("://");
      expect(out).not.toMatch(
        /\b(?:https?|ws|wss|ftp|mailto|javascript|data|file|vscode|tel|sms):/i,
      );
      // www. autolink
      expect(out).not.toMatch(/\bwww\./i);
      // Bracket / formatting / mention sigils MUST be stripped
      expect(out).not.toMatch(/[`*~#|!&\\[\]()<>{}@]/);
      // Control chars and bidi formatters
      // biome-ignore lint/suspicious/noControlCharactersInRegex: invariant assertion
      expect(out).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(out).not.toMatch(/[​-‏‪-‮⁦-⁩﻿]/u);
    }
  });

  it(`for ${ITERATIONS} random messages: no non-ASCII dotted host shape survives`, () => {
    const rng = seededRng(0xfeed);
    for (let i = 0; i < ITERATIONS; i++) {
      const tokenCount = 1 + Math.floor(rng() * 8);
      const parts: string[] = [];
      for (let j = 0; j < tokenCount; j++) {
        const idx = Math.floor(rng() * POOL.length);
        parts.push(POOL[idx] ?? "");
      }
      const msg = parts.join(" ");
      const out = safeText(msg);
      // No token containing both `.` and a non-ASCII letter.
      const tokens = out.split(/\s+/);
      for (const t of tokens) {
        if (!t.includes(".")) continue;
        // biome-ignore lint/suspicious/noControlCharactersInRegex: invariant assertion
        const hasNonAscii = /[^\x00-\x7f]/.test(t);
        expect(hasNonAscii).toBe(false);
      }
    }
  });

  it(`length cap holds for very long random inputs (200 char limit + ellipsis)`, () => {
    const rng = seededRng(0xdead);
    for (let i = 0; i < 50; i++) {
      const length = 100 + Math.floor(rng() * 5000);
      const chars: string[] = [];
      for (let j = 0; j < length; j++) {
        // Produce a mix of ASCII printable + occasional Unicode + occasional space.
        const r = rng();
        if (r < 0.05) chars.push(" ");
        else if (r < 0.1) chars.push(String.fromCharCode(0x4e00 + Math.floor(rng() * 1024)));
        else chars.push(String.fromCharCode(33 + Math.floor(rng() * 94)));
      }
      const msg = chars.join("");
      const out = safeText(msg);
      // "Invalid input: " (15) + 200 + "…" (1) = 216 max.
      expect(out.length).toBeLessThanOrEqual(216);
    }
  });
});

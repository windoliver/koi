import { describe, expect, test } from "bun:test";
import {
  defaultRebuildPrompt,
  normalizeVerifierResult,
  redactCredentials,
  sanitizeDetails,
  truncateBytes,
} from "./rebuild-prompt.js";
import type { RebuildPromptContext, VerifierResult } from "./types.js";

describe("redactCredentials", () => {
  test("redacts OpenAI / Anthropic / generic sk- keys", () => {
    const input = "Config: sk-proj-ABCDEF1234567890XYZabcdef and sk-ant-01234567890ABCDEFGHIJK";
    const out = redactCredentials(input);
    expect(out).not.toContain("ABCDEF1234567890");
    expect(out).not.toContain("01234567890ABCDEFGHIJK");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts Stripe-style sk_live / sk_test keys", () => {
    const input = "stripe: sk_live_AbCdEf1234567890GhIjKl and sk_test_0000000000000000ABCD";
    const out = redactCredentials(input);
    expect(out).not.toContain("AbCdEf1234567890");
    expect(out).not.toContain("0000000000000000");
  });

  test("redacts GitHub tokens (ghp_, gho_, ghs_, ghu_)", () => {
    const input =
      "Tokens: ghp_abcdefghijklmnopqrstuvwxyz0123 ghs_0123456789abcdef0123456789 ghu_AAAA0000BBBB1111CCCC";
    const out = redactCredentials(input);
    expect(out).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(out).not.toContain("0123456789abcdef0123456789");
  });

  test("redacts JWT tokens", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const out = redactCredentials(`auth = ${jwt}`);
    expect(out).not.toContain("SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts Bearer tokens but keeps the Bearer prefix", () => {
    const out = redactCredentials("Authorization: Bearer abc123XYZ0987654321SuperSecret");
    expect(out).not.toContain("SuperSecret");
    expect(out).toContain("Bearer [REDACTED]");
  });

  test("redacts password in URL basic-auth but keeps scheme + host", () => {
    const out = redactCredentials("postgres://admin:hunter2-secret-pw@db.internal:5432/app");
    expect(out).not.toContain("hunter2-secret-pw");
    expect(out).toContain("postgres://admin");
    expect(out).toContain("@db.internal");
    expect(out).toContain("[REDACTED]");
  });

  test("redacts key=value pairs for common secret names", () => {
    const out = redactCredentials(
      "password=letmein123 api_key=ABC123DEF456 SECRET: topsecretvalue access_token: a1b2c3d4e5f6g7h8",
    );
    expect(out).not.toContain("letmein123");
    expect(out).not.toContain("ABC123DEF456");
    expect(out).not.toContain("topsecretvalue");
    expect(out).not.toContain("a1b2c3d4e5f6g7h8");
  });

  test("leaves non-credential text intact", () => {
    const input = "assertion failed: expected 2, got 3 at line 12";
    expect(redactCredentials(input)).toBe(input);
  });

  test("leaves short values alone to avoid false positives on tokens/variables", () => {
    // sk-ab is too short to be an API key; should not be redacted
    const input = "function sk-api returned 200";
    expect(redactCredentials(input)).toBe(input);
  });
});

describe("sanitizeDetails", () => {
  test("strips ANSI color codes", () => {
    const input = "\x1B[31mred text\x1B[0m normal";
    expect(sanitizeDetails(input)).toBe("red text normal");
  });

  test("sanitize pipeline also redacts credentials", () => {
    const input = "\x1B[31mError:\x1B[0m sk-proj-ABCDEF1234567890XYZabc failed";
    const out = sanitizeDetails(input);
    expect(out).not.toContain("\x1B");
    expect(out).not.toContain("ABCDEF1234567890XYZabc");
    expect(out).toContain("[REDACTED]");
  });

  test("strips ANSI cursor movement", () => {
    expect(sanitizeDetails("\x1B[2J\x1B[Hhello")).toBe("hello");
  });

  test("strips OSC (terminal title) sequences", () => {
    expect(sanitizeDetails("\x1B]0;evil title\x07legit")).toBe("legit");
  });

  test("preserves newlines and tabs", () => {
    expect(sanitizeDetails("line1\nline2\tindented")).toBe("line1\nline2\tindented");
  });

  test("redacts other control chars as ?", () => {
    expect(sanitizeDetails("before\x00\x01\x7Fafter")).toBe("before???after");
  });
});

describe("truncateBytes", () => {
  test("returns unchanged when under limit", () => {
    expect(truncateBytes("hello", 100)).toBe("hello");
  });

  test("truncates when over limit and appends marker", () => {
    const long = "x".repeat(1000);
    const result = truncateBytes(long, 50);
    expect(result.length).toBeLessThanOrEqual(50);
    expect(result.endsWith("...[truncated]")).toBe(true);
  });

  test("utf-8 safe — does not split multi-byte characters", () => {
    // Each emoji is 4 bytes in UTF-8
    const input = "😀😀😀😀😀😀😀😀"; // 32 bytes
    const result = truncateBytes(input, 20);
    // Must still be valid UTF-8 (no broken surrogates)
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(new TextEncoder().encode(result)),
    ).not.toThrow();
  });
});

describe("normalizeVerifierResult", () => {
  test("sanitizes and truncates failure details", () => {
    const result: VerifierResult = {
      ok: false,
      reason: "exit_nonzero",
      details: `\x1B[31m${"x".repeat(5000)}\x1B[0m`,
      exitCode: 1,
    };
    const normalized = normalizeVerifierResult(result, 100);
    expect(normalized.ok).toBe(false);
    if (normalized.ok) throw new Error("unreachable");
    expect(normalized.details).not.toContain("\x1B");
    expect(new TextEncoder().encode(normalized.details).length).toBeLessThanOrEqual(100);
    expect(normalized.exitCode).toBe(1);
  });

  test("preserves ok results", () => {
    const r: VerifierResult = { ok: true };
    expect(normalizeVerifierResult(r)).toEqual(r);
  });

  test("sanitizes ok details if present", () => {
    const r: VerifierResult = { ok: true, details: "\x1B[32mok\x1B[0m" };
    const normalized = normalizeVerifierResult(r);
    if (!normalized.ok) throw new Error("unreachable");
    expect(normalized.details).toBe("ok");
  });
});

describe("defaultRebuildPrompt", () => {
  const base: RebuildPromptContext = {
    iteration: 3,
    initialPrompt: "Fix the tests",
    latestFailure: {
      ok: false,
      reason: "exit_nonzero",
      details: "foo.test.ts:12 expected 2 got 3",
      exitCode: 1,
    },
    recentFailures: [],
    tokensConsumed: "unmetered",
  };

  test("includes the initial prompt verbatim", () => {
    expect(defaultRebuildPrompt(base)).toContain("Fix the tests");
  });

  test("mentions the previous iteration number (iteration - 1)", () => {
    expect(defaultRebuildPrompt(base)).toContain("iteration 2");
  });

  test("includes the typed failure reason", () => {
    expect(defaultRebuildPrompt(base)).toContain("reason: exit_nonzero");
  });

  test("includes exit code when present", () => {
    expect(defaultRebuildPrompt(base)).toContain("exit code: 1");
  });

  test("omits exit code line when absent", () => {
    const ctx: RebuildPromptContext = {
      ...base,
      latestFailure: { ok: false, reason: "timeout", details: "hung" },
    };
    const out = defaultRebuildPrompt(ctx);
    expect(out).not.toContain("exit code:");
  });

  test("includes the failure details", () => {
    expect(defaultRebuildPrompt(base)).toContain("expected 2 got 3");
  });

  test("does not include history from recentFailures (default)", () => {
    const ctx: RebuildPromptContext = {
      ...base,
      recentFailures: [
        { ok: false, reason: "exit_nonzero", details: "old failure one" },
        { ok: false, reason: "exit_nonzero", details: "old failure two" },
      ],
    };
    const out = defaultRebuildPrompt(ctx);
    expect(out).not.toContain("old failure one");
    expect(out).not.toContain("old failure two");
  });

  test("returns initial prompt if latestFailure is ok (defensive)", () => {
    const ctx: RebuildPromptContext = { ...base, latestFailure: { ok: true } };
    expect(defaultRebuildPrompt(ctx)).toBe("Fix the tests");
  });
});

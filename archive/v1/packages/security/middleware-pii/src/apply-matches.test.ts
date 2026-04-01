import { describe, expect, test } from "bun:test";
import { applyMatches } from "./apply-matches.js";
import type { PIIMatch } from "./types.js";

function makeMatch(text: string, start: number, end: number, kind: string): PIIMatch {
  return { text, start, end, kind };
}

describe("applyMatches", () => {
  test("returns identity for empty matches", () => {
    const result = applyMatches("hello world", [], "redact");
    expect(result.text).toBe("hello world");
    expect(result.matches).toHaveLength(0);
  });

  test("redacts a single match", () => {
    const matches = [makeMatch("user@example.com", 9, 25, "email")];
    const result = applyMatches("Contact: user@example.com today", matches, "redact");
    expect(result.text).toBe("Contact: [REDACTED_EMAIL] today");
    expect(result.matches).toHaveLength(1);
  });

  test("applies multiple non-overlapping matches in correct order", () => {
    const text = "Email: a@b.com IP: 1.2.3.4";
    const matches = [makeMatch("a@b.com", 7, 14, "email"), makeMatch("1.2.3.4", 19, 26, "ip")];
    const result = applyMatches(text, matches, "redact");
    expect(result.text).toBe("Email: [REDACTED_EMAIL] IP: [REDACTED_IP]");
  });

  test("resolves overlapping matches: longest wins", () => {
    const text = "See https://user@example.com/page";
    const urlStart = text.indexOf("https://user@example.com/page");
    const urlEnd = urlStart + "https://user@example.com/page".length;
    const emailStart = text.indexOf("user@example.com");
    const emailEnd = emailStart + "user@example.com".length;
    const matches = [
      makeMatch("https://user@example.com/page", urlStart, urlEnd, "url"),
      makeMatch("user@example.com", emailStart, emailEnd, "email"),
    ];
    const result = applyMatches(text, matches, "redact");
    expect(result.text).toBe("See [REDACTED_URL]");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.kind).toBe("url");
  });

  test("uses mask strategy correctly", () => {
    const matches = [makeMatch("john@example.com", 0, 16, "email")];
    const result = applyMatches("john@example.com", matches, "mask");
    expect(result.text).toBe("j***@example.com");
  });

  test("uses hash strategy correctly", () => {
    const matches = [makeMatch("user@test.com", 0, 13, "email")];
    const createHasher = () => new Bun.CryptoHasher("sha256", "secret");
    const result = applyMatches("user@test.com", matches, "hash", createHasher);
    expect(result.text).toMatch(/^<email:[0-9a-f]{16}>$/);
  });

  test("preserves text indices with reverse-order application", () => {
    const text = "A a@b.com B c@d.com C";
    const matches = [makeMatch("a@b.com", 2, 9, "email"), makeMatch("c@d.com", 12, 19, "email")];
    const result = applyMatches(text, matches, "redact");
    expect(result.text).toBe("A [REDACTED_EMAIL] B [REDACTED_EMAIL] C");
  });
});

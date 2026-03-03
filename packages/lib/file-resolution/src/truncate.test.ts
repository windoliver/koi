import { describe, expect, test } from "bun:test";
import { truncateSafe } from "./truncate.js";

describe("truncateSafe", () => {
  test("returns text unchanged when within limit", () => {
    expect(truncateSafe("hello", 10)).toBe("hello");
  });

  test("returns text unchanged when exactly at limit", () => {
    expect(truncateSafe("hello", 5)).toBe("hello");
  });

  test("truncates ASCII text normally", () => {
    expect(truncateSafe("hello world", 5)).toBe("hello");
  });

  test("does not split a surrogate pair at boundary", () => {
    // "\u{1F600}" = 😀 = 2 JS chars (high surrogate + low surrogate)
    // "ab😀cd" = ['a', 'b', '\uD83D', '\uDE00', 'c', 'd'] = 6 code units
    const text = "ab\u{1F600}cd";
    // maxChars=3 would land on the high surrogate of 😀 — must back off to 2
    expect(truncateSafe(text, 3)).toBe("ab");
  });

  test("keeps surrogate pair when boundary lands after the pair", () => {
    const text = "ab\u{1F600}cd";
    // maxChars=4 includes both code units of the emoji
    expect(truncateSafe(text, 4)).toBe("ab\u{1F600}");
  });

  test("handles multiple emoji correctly", () => {
    // 4 emoji = 8 JS chars
    const text = "\u{1F600}\u{1F601}\u{1F602}\u{1F603}";
    // maxChars=5 lands on high surrogate of 3rd emoji — back off to 4
    expect(truncateSafe(text, 5)).toBe("\u{1F600}\u{1F601}");
  });

  test("handles emoji followed by ASCII", () => {
    const text = "\u{1F600}abc";
    // maxChars=1 lands on high surrogate — back off to 0
    expect(truncateSafe(text, 1)).toBe("");
  });

  test("handles CJK characters (BMP, no surrogate pairs)", () => {
    const text = "\u4F60\u597D\u4E16\u754C"; // 你好世界 — 4 chars, no surrogates
    expect(truncateSafe(text, 2)).toBe("\u4F60\u597D");
  });

  test("handles empty string", () => {
    expect(truncateSafe("", 5)).toBe("");
  });

  test("handles maxChars=0", () => {
    expect(truncateSafe("hello", 0)).toBe("");
  });
});

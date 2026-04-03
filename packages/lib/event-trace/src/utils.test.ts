import { describe, expect, test } from "bun:test";
import { pickDefined, sumOptional, truncateContent } from "./utils.js";

describe("pickDefined", () => {
  test("strips undefined values", () => {
    const result = pickDefined({ a: 1, b: undefined, c: "hello" });
    expect(result).toEqual({ a: 1, c: "hello" });
  });

  test("returns empty object when all undefined", () => {
    const result = pickDefined({ a: undefined, b: undefined });
    expect(result).toEqual({});
  });

  test("preserves all values when none undefined", () => {
    const result = pickDefined({ x: 0, y: false, z: "" });
    expect(result).toEqual({ x: 0, y: false, z: "" });
  });

  test("handles empty input", () => {
    const result = pickDefined({});
    expect(result).toEqual({});
  });

  test("preserves null (only strips undefined)", () => {
    const result = pickDefined({ a: null, b: 1 });
    expect(result).toEqual({ a: null, b: 1 });
  });

  test("preserves zero and false", () => {
    const result = pickDefined({ count: 0, active: false });
    expect(result).toEqual({ count: 0, active: false });
  });
});

describe("sumOptional", () => {
  test("sums defined values", () => {
    const items = [{ value: 10 }, { value: 20 }, { value: 30 }];
    expect(sumOptional(items, (i) => i.value)).toBe(60);
  });

  test("returns undefined when no values defined", () => {
    const items = [{ value: undefined }, { value: undefined }];
    expect(sumOptional(items, (i) => i.value)).toBeUndefined();
  });

  test("skips undefined values in sum", () => {
    const items = [{ value: 10 }, { value: undefined }, { value: 30 }];
    expect(sumOptional(items, (i) => i.value)).toBe(40);
  });

  test("returns undefined for empty array", () => {
    expect(sumOptional([], () => 1)).toBeUndefined();
  });

  test("handles single item", () => {
    expect(sumOptional([{ v: 42 }], (i) => i.v)).toBe(42);
  });

  test("handles single undefined item", () => {
    expect(sumOptional([{ v: undefined }], (i) => i.v)).toBeUndefined();
  });

  test("preserves distinction: sum of zeros vs no data", () => {
    const zeros = [{ v: 0 }, { v: 0 }];
    expect(sumOptional(zeros, (i) => i.v)).toBe(0);

    const noData = [{ v: undefined }, { v: undefined }];
    expect(sumOptional(noData, (i) => i.v)).toBeUndefined();
  });
});

describe("truncateContent", () => {
  test("returns full text when under limit", () => {
    const result = truncateContent("hello world", 100);
    expect(result).toEqual({ text: "hello world" });
    expect(result.truncated).toBeUndefined();
  });

  test("truncates with head+tail when over limit", () => {
    const longText = "a".repeat(10000);
    const result = truncateContent(longText, 100);
    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(10000);
    expect(result.text).toContain("...[truncated]...");
    // Head and tail should each be ~50 chars
    expect(result.text?.length).toBeLessThan(200);
  });

  test("exact boundary: text at limit is not truncated", () => {
    const text = "a".repeat(100);
    const result = truncateContent(text, 100);
    expect(result.truncated).toBeUndefined();
    expect(result.text).toBe(text);
  });

  test("uses default limit of 8192", () => {
    const shortText = "a".repeat(8000);
    expect(truncateContent(shortText).truncated).toBeUndefined();

    const longText = "a".repeat(9000);
    expect(truncateContent(longText).truncated).toBe(true);
  });

  test("empty string is not truncated", () => {
    const result = truncateContent("");
    expect(result).toEqual({ text: "" });
  });

  test("multibyte Unicode stays within byte budget", () => {
    // Each emoji is 4 bytes in UTF-8
    const emojis = "🎉".repeat(100); // 400 bytes
    const result = truncateContent(emojis, 100);

    expect(result.truncated).toBe(true);
    expect(result.originalSize).toBe(400);

    // The truncated text should be within budget when re-encoded
    const truncatedBytes = new TextEncoder().encode(result.text ?? "").length;
    // Allow some slack for the separator
    expect(truncatedBytes).toBeLessThanOrEqual(150);
  });

  test("CJK characters stay within byte budget", () => {
    // Each CJK char is 3 bytes in UTF-8
    const cjk = "你好世界".repeat(50); // 200 chars = 600 bytes
    const result = truncateContent(cjk, 100);

    expect(result.truncated).toBe(true);
    const truncatedBytes = new TextEncoder().encode(result.text ?? "").length;
    expect(truncatedBytes).toBeLessThanOrEqual(150);
  });

  test("does not split multibyte characters", () => {
    const emojis = "🎉🎊🎈🎁".repeat(25); // 100 emojis
    const result = truncateContent(emojis, 50);

    // The result should be valid UTF-8 (no replacement characters)
    expect(result.text).not.toContain("\uFFFD");
  });
});

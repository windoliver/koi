import { describe, expect, test } from "bun:test";
import { normalizeIndentation, normalizeWhitespace } from "./normalize.js";

describe("normalizeWhitespace", () => {
  test("collapses spaces to single space", () => {
    expect(normalizeWhitespace("hello   world")).toBe("hello world");
  });

  test("collapses tabs and newlines", () => {
    expect(normalizeWhitespace("hello\t\n  world")).toBe("hello world");
  });

  test("trims leading and trailing whitespace", () => {
    expect(normalizeWhitespace("  hello  ")).toBe("hello");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(normalizeWhitespace("   \t\n  ")).toBe("");
  });

  test("preserves single-spaced text", () => {
    expect(normalizeWhitespace("hello world")).toBe("hello world");
  });
});

describe("normalizeIndentation", () => {
  test("strips common leading whitespace", () => {
    const input = "    line1\n    line2\n    line3";
    expect(normalizeIndentation(input)).toBe("line1\nline2\nline3");
  });

  test("preserves relative indentation", () => {
    const input = "    line1\n      line2\n    line3";
    expect(normalizeIndentation(input)).toBe("line1\n  line2\nline3");
  });

  test("ignores empty lines when computing minimum indent", () => {
    const input = "    line1\n\n    line2";
    expect(normalizeIndentation(input)).toBe("line1\n\nline2");
  });

  test("returns unchanged when no common indent", () => {
    const input = "line1\n  line2\n    line3";
    expect(normalizeIndentation(input)).toBe("line1\n  line2\n    line3");
  });

  test("handles all-empty input", () => {
    const input = "\n\n";
    expect(normalizeIndentation(input)).toBe("\n\n");
  });

  test("handles tab indentation", () => {
    const input = "\t\tline1\n\t\tline2";
    expect(normalizeIndentation(input)).toBe("line1\nline2");
  });
});

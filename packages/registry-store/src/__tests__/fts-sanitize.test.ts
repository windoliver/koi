import { describe, expect, test } from "bun:test";
import { sanitizeFtsQuery } from "../fts-sanitize.js";

describe("sanitizeFtsQuery", () => {
  test("passes through plain text", () => {
    expect(sanitizeFtsQuery("hello world")).toBe("hello world");
  });

  test("returns empty string for empty input", () => {
    expect(sanitizeFtsQuery("")).toBe("");
  });

  test("returns empty string for whitespace-only input", () => {
    expect(sanitizeFtsQuery("   ")).toBe("");
  });

  test("strips double quotes", () => {
    expect(sanitizeFtsQuery('"exact phrase"')).toBe("exact phrase");
  });

  test("strips asterisks (prefix queries)", () => {
    expect(sanitizeFtsQuery("hel*")).toBe("hel");
  });

  test("strips carets (boost)", () => {
    expect(sanitizeFtsQuery("important^2")).toBe("important 2");
  });

  test("strips parentheses", () => {
    expect(sanitizeFtsQuery("(foo OR bar)")).toBe("foo bar");
  });

  test("strips curly braces", () => {
    expect(sanitizeFtsQuery("{column}")).toBe("column");
  });

  test("strips colons (column filters)", () => {
    expect(sanitizeFtsQuery("name:value")).toBe("name value");
  });

  test("removes AND operator", () => {
    expect(sanitizeFtsQuery("foo AND bar")).toBe("foo bar");
  });

  test("removes OR operator", () => {
    expect(sanitizeFtsQuery("foo OR bar")).toBe("foo bar");
  });

  test("removes NOT operator", () => {
    expect(sanitizeFtsQuery("NOT bad")).toBe("bad");
  });

  test("removes NEAR operator", () => {
    expect(sanitizeFtsQuery("foo NEAR bar")).toBe("foo bar");
  });

  test("removes operators case-insensitively", () => {
    expect(sanitizeFtsQuery("foo and bar or baz")).toBe("foo bar baz");
  });

  test("does not strip operators embedded in words", () => {
    expect(sanitizeFtsQuery("android notebook")).toBe("android notebook");
  });

  test("collapses multiple spaces", () => {
    expect(sanitizeFtsQuery("foo   bar   baz")).toBe("foo bar baz");
  });

  test("handles combined edge case", () => {
    expect(sanitizeFtsQuery('"hello" AND world* NOT (bad)')).toBe("hello world bad");
  });
});

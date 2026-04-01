import { describe, expect, test } from "bun:test";
import { isValidJsonPointer, parseJsonPointer } from "./validate-data-model.js";

describe("parseJsonPointer", () => {
  test("parses empty string as root (no tokens)", () => {
    const result = parseJsonPointer("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual([]);
  });

  test("parses single-level pointer", () => {
    const result = parseJsonPointer("/name");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(["name"]);
  });

  test("parses multi-level pointer", () => {
    const result = parseJsonPointer("/a/b/c");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(["a", "b", "c"]);
  });

  test("unescapes ~0 to ~ and ~1 to /", () => {
    const result = parseJsonPointer("/a~0b/c~1d");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(["a~b", "c/d"]);
  });

  test("rejects pointer not starting with /", () => {
    const result = parseJsonPointer("invalid");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });

  test("rejects invalid escape sequences", () => {
    const result = parseJsonPointer("/a~2b");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION");
  });
});

describe("isValidJsonPointer", () => {
  test("returns true for valid pointers", () => {
    expect(isValidJsonPointer("")).toBe(true);
    expect(isValidJsonPointer("/foo")).toBe(true);
    expect(isValidJsonPointer("/foo/bar")).toBe(true);
  });

  test("returns false for invalid pointers", () => {
    expect(isValidJsonPointer("noslash")).toBe(false);
    expect(isValidJsonPointer("/bad~escape")).toBe(false);
  });
});

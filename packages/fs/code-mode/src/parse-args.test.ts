import { describe, expect, test } from "bun:test";
import { parseArray, parseOptionalString, parseString } from "./parse-args.js";

describe("parseString", () => {
  test("returns value for valid non-empty string", () => {
    const result = parseString({ name: "hello" }, "name");
    expect(result).toEqual({ ok: true, value: "hello" });
  });

  test("returns error for missing key", () => {
    const result = parseString({}, "name");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.code).toBe("VALIDATION");
      expect(result.err.error).toContain("name");
    }
  });

  test("returns error for empty string", () => {
    const result = parseString({ name: "" }, "name");
    expect(result.ok).toBe(false);
  });

  test("returns error for non-string value", () => {
    const result = parseString({ name: 42 }, "name");
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalString", () => {
  test("returns undefined for missing key", () => {
    const result = parseOptionalString({}, "key");
    expect(result).toEqual({ ok: true, value: undefined });
  });

  test("returns value for valid string", () => {
    const result = parseOptionalString({ key: "val" }, "key");
    expect(result).toEqual({ ok: true, value: "val" });
  });

  test("returns error for non-string value", () => {
    const result = parseOptionalString({ key: 123 }, "key");
    expect(result.ok).toBe(false);
  });
});

describe("parseArray", () => {
  test("returns value for valid array", () => {
    const result = parseArray({ items: [1, 2, 3] }, "items");
    expect(result).toEqual({ ok: true, value: [1, 2, 3] });
  });

  test("returns error for non-array", () => {
    const result = parseArray({ items: "not array" }, "items");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.err.code).toBe("VALIDATION");
    }
  });

  test("returns error for missing key", () => {
    const result = parseArray({}, "items");
    expect(result.ok).toBe(false);
  });
});

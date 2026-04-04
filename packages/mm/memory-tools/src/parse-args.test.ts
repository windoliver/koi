import { describe, expect, test } from "bun:test";
import {
  parseOptionalBoolean,
  parseOptionalEnum,
  parseOptionalNumber,
  parseOptionalString,
  parseOptionalStringArray,
  parseOptionalTimestamp,
  parseString,
} from "./parse-args.js";

describe("parseString", () => {
  test("returns value for non-empty string", () => {
    const result = parseString({ name: "hello" }, "name");
    expect(result).toEqual({ ok: true, value: "hello" });
  });

  test("returns error for empty string", () => {
    const result = parseString({ name: "" }, "name");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.code).toBe("VALIDATION");
  });

  test("returns error for missing key", () => {
    const result = parseString({}, "name");
    expect(result.ok).toBe(false);
  });

  test("returns error for non-string value", () => {
    const result = parseString({ name: 42 }, "name");
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalString", () => {
  test("returns value for string", () => {
    expect(parseOptionalString({ k: "v" }, "k")).toEqual({ ok: true, value: "v" });
  });

  test("returns undefined for missing key", () => {
    expect(parseOptionalString({}, "k")).toEqual({ ok: true, value: undefined });
  });

  test("returns error for non-string", () => {
    const result = parseOptionalString({ k: 42 }, "k");
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalNumber", () => {
  test("returns value for number", () => {
    expect(parseOptionalNumber({ n: 5 }, "n")).toEqual({ ok: true, value: 5 });
  });

  test("returns undefined for missing key", () => {
    expect(parseOptionalNumber({}, "n")).toEqual({ ok: true, value: undefined });
  });

  test("returns error for non-number", () => {
    const result = parseOptionalNumber({ n: "five" }, "n");
    expect(result.ok).toBe(false);
  });

  test("returns error for NaN", () => {
    const result = parseOptionalNumber({ n: Number.NaN }, "n");
    expect(result.ok).toBe(false);
  });

  test("returns error for Infinity", () => {
    const result = parseOptionalNumber({ n: Number.POSITIVE_INFINITY }, "n");
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalBoolean", () => {
  test("returns value for boolean", () => {
    expect(parseOptionalBoolean({ b: true }, "b")).toEqual({ ok: true, value: true });
  });

  test("returns undefined for missing key", () => {
    expect(parseOptionalBoolean({}, "b")).toEqual({ ok: true, value: undefined });
  });

  test("returns error for non-boolean", () => {
    const result = parseOptionalBoolean({ b: "true" }, "b");
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalStringArray", () => {
  test("returns value for string array", () => {
    expect(parseOptionalStringArray({ a: ["x", "y"] }, "a")).toEqual({
      ok: true,
      value: ["x", "y"],
    });
  });

  test("returns undefined for missing key", () => {
    expect(parseOptionalStringArray({}, "a")).toEqual({ ok: true, value: undefined });
  });

  test("returns error for mixed array", () => {
    const result = parseOptionalStringArray({ a: ["x", 1] }, "a");
    expect(result.ok).toBe(false);
  });

  test("returns error for non-array", () => {
    const result = parseOptionalStringArray({ a: "x" }, "a");
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalEnum", () => {
  const allowed = ["hot", "warm", "cold"] as const;

  test("returns value for valid enum", () => {
    expect(parseOptionalEnum({ t: "hot" }, "t", allowed)).toEqual({ ok: true, value: "hot" });
  });

  test("returns undefined for missing key", () => {
    expect(parseOptionalEnum({}, "t", allowed)).toEqual({ ok: true, value: undefined });
  });

  test("returns error for invalid enum value", () => {
    const result = parseOptionalEnum({ t: "lukewarm" }, "t", allowed);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.err.error).toContain("hot");
  });

  test("returns error for non-string", () => {
    const result = parseOptionalEnum({ t: 1 }, "t", allowed);
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalTimestamp", () => {
  test("returns epoch ms for valid ISO timestamp", () => {
    const result = parseOptionalTimestamp({ d: "2026-01-15T12:00:00Z" }, "d");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(Date.parse("2026-01-15T12:00:00Z"));
  });

  test("returns undefined for missing key", () => {
    expect(parseOptionalTimestamp({}, "d")).toEqual({ ok: true, value: undefined });
  });

  test("returns error for invalid timestamp", () => {
    const result = parseOptionalTimestamp({ d: "not-a-date" }, "d");
    expect(result.ok).toBe(false);
  });

  test("returns error for non-string", () => {
    const result = parseOptionalTimestamp({ d: 12345 }, "d");
    expect(result.ok).toBe(false);
  });
});

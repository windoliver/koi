import { describe, expect, test } from "bun:test";
import {
  parseEnum,
  parseOptionalEnum,
  parseOptionalNumber,
  parseOptionalString,
  parseOptionalStringArray,
  parseString,
} from "./parse-args.js";

describe("parseString", () => {
  test("returns value for valid string", () => {
    const result = parseString({ name: "hello" }, "name");
    expect(result).toEqual({ ok: true, value: "hello" });
  });

  test("fails for empty string", () => {
    const result = parseString({ name: "" }, "name");
    expect(result.ok).toBe(false);
  });

  test("fails for missing key", () => {
    const result = parseString({}, "name");
    expect(result.ok).toBe(false);
  });

  test("fails for number value", () => {
    const result = parseString({ name: 42 }, "name");
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalString", () => {
  test("returns value for present string", () => {
    const result = parseOptionalString({ name: "hello" }, "name");
    expect(result).toEqual({ ok: true, value: "hello" });
  });

  test("returns undefined for missing key", () => {
    const result = parseOptionalString({}, "name");
    expect(result).toEqual({ ok: true, value: undefined });
  });

  test("fails for non-string value", () => {
    const result = parseOptionalString({ name: 42 }, "name");
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalNumber", () => {
  test("returns value for present number", () => {
    const result = parseOptionalNumber({ limit: 10 }, "limit");
    expect(result).toEqual({ ok: true, value: 10 });
  });

  test("returns undefined for missing key", () => {
    const result = parseOptionalNumber({}, "limit");
    expect(result).toEqual({ ok: true, value: undefined });
  });

  test("fails for string value", () => {
    const result = parseOptionalNumber({ limit: "ten" }, "limit");
    expect(result.ok).toBe(false);
  });
});

describe("parseEnum", () => {
  const allowed = ["a", "b", "c"] as const;

  test("returns value for valid enum member", () => {
    const result = parseEnum({ kind: "b" }, "kind", allowed);
    expect(result).toEqual({ ok: true, value: "b" });
  });

  test("fails for invalid enum value", () => {
    const result = parseEnum({ kind: "d" }, "kind", allowed);
    expect(result.ok).toBe(false);
  });

  test("fails for missing key", () => {
    const result = parseEnum({}, "kind", allowed);
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalEnum", () => {
  const allowed = ["x", "y"] as const;

  test("returns value for valid enum member", () => {
    const result = parseOptionalEnum({ kind: "x" }, "kind", allowed);
    expect(result).toEqual({ ok: true, value: "x" });
  });

  test("returns undefined for missing key", () => {
    const result = parseOptionalEnum({}, "kind", allowed);
    expect(result).toEqual({ ok: true, value: undefined });
  });

  test("fails for invalid enum value", () => {
    const result = parseOptionalEnum({ kind: "z" }, "kind", allowed);
    expect(result.ok).toBe(false);
  });
});

describe("parseOptionalStringArray", () => {
  test("returns value for valid string array", () => {
    const result = parseOptionalStringArray({ tags: ["a", "b"] }, "tags");
    expect(result).toEqual({ ok: true, value: ["a", "b"] });
  });

  test("returns undefined for missing key", () => {
    const result = parseOptionalStringArray({}, "tags");
    expect(result).toEqual({ ok: true, value: undefined });
  });

  test("fails for non-array value", () => {
    const result = parseOptionalStringArray({ tags: "hello" }, "tags");
    expect(result.ok).toBe(false);
  });

  test("fails for array with non-string elements", () => {
    const result = parseOptionalStringArray({ tags: ["a", 42] }, "tags");
    expect(result.ok).toBe(false);
  });
});

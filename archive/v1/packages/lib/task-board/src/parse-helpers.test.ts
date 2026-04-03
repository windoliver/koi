import { describe, expect, test } from "bun:test";
import { isRecord, parseEnumField, parseStringField } from "./parse-helpers.js";

describe("isRecord", () => {
  test("returns true for plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  test("returns false for non-objects", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(42)).toBe(false);
    expect(isRecord("string")).toBe(false);
  });
});

describe("parseStringField", () => {
  test("returns value for valid non-empty string", () => {
    expect(parseStringField({ name: "hello" }, "name")).toBe("hello");
  });

  test("returns error for missing field", () => {
    const result = parseStringField({}, "name");
    expect(typeof result).toBe("object");
    if (typeof result === "object") {
      expect(result.error).toContain("name");
    }
  });

  test("returns error for empty string", () => {
    const result = parseStringField({ name: "" }, "name");
    expect(typeof result).toBe("object");
  });
});

describe("parseEnumField", () => {
  test("returns value for valid enum", () => {
    expect(parseEnumField({ v: "accept" }, "v", ["accept", "reject"])).toBe("accept");
  });

  test("returns error for invalid value", () => {
    const result = parseEnumField({ v: "maybe" }, "v", ["accept", "reject"]);
    expect(typeof result).toBe("object");
    if (typeof result === "object") {
      expect(result.error).toContain("accept");
    }
  });
});

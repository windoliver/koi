/**
 * Tests for self-test verification — subset matching behavior.
 *
 * Regression tests for #1169: forge_edit should not fail when the edited
 * tool adds extra fields to its output.
 */

import { describe, expect, test } from "bun:test";

// isSubsetMatch is not exported directly, so we inline the same logic
// for focused unit testing of the matching semantics.
function isSubsetMatch(actual: unknown, expected: unknown): boolean {
  if (actual === expected) return true;
  if (expected === null || actual === null) return expected === actual;
  if (typeof expected !== typeof actual) return false;
  if (typeof expected !== "object") return false;

  const expIsArray = Array.isArray(expected);
  const actIsArray = Array.isArray(actual);
  if (expIsArray !== actIsArray) return false;

  if (expIsArray && actIsArray) {
    if (expected.length !== actual.length) return false;
    for (let i = 0; i < expected.length; i++) {
      if (!isSubsetMatch(actual[i], expected[i])) return false;
    }
    return true;
  }

  const expObj = expected as Record<string, unknown>;
  const actObj = actual as Record<string, unknown>;

  for (const key of Object.keys(expObj)) {
    if (!(key in actObj)) return false;
    if (!isSubsetMatch(actObj[key], expObj[key])) return false;
  }
  return true;
}

describe("isSubsetMatch", () => {
  test("exact match passes", () => {
    expect(isSubsetMatch({ fahrenheit: 32 }, { fahrenheit: 32 })).toBe(true);
  });

  test("actual has extra fields — passes (subset match)", () => {
    expect(isSubsetMatch({ fahrenheit: 32, kelvin: 273.15 }, { fahrenheit: 32 })).toBe(true);
  });

  test("actual missing expected field — fails", () => {
    expect(isSubsetMatch({ kelvin: 273.15 }, { fahrenheit: 32 })).toBe(false);
  });

  test("value mismatch — fails", () => {
    expect(isSubsetMatch({ fahrenheit: 99 }, { fahrenheit: 32 })).toBe(false);
  });

  test("nested objects with extra fields — passes", () => {
    expect(
      isSubsetMatch(
        { data: { name: "Alice", age: 30, email: "a@b.com" } },
        { data: { name: "Alice", age: 30 } },
      ),
    ).toBe(true);
  });

  test("nested object missing expected key — fails", () => {
    expect(isSubsetMatch({ data: { name: "Alice" } }, { data: { name: "Alice", age: 30 } })).toBe(
      false,
    );
  });

  test("primitives match exactly", () => {
    expect(isSubsetMatch(42, 42)).toBe(true);
    expect(isSubsetMatch("hello", "hello")).toBe(true);
    expect(isSubsetMatch(true, true)).toBe(true);
    expect(isSubsetMatch(null, null)).toBe(true);
  });

  test("primitive mismatch fails", () => {
    expect(isSubsetMatch(42, 43)).toBe(false);
    expect(isSubsetMatch("hello", "world")).toBe(false);
    expect(isSubsetMatch(null, 0)).toBe(false);
  });

  test("arrays require exact length and order", () => {
    expect(isSubsetMatch([1, 2, 3], [1, 2, 3])).toBe(true);
    expect(isSubsetMatch([1, 2, 3, 4], [1, 2, 3])).toBe(false);
    expect(isSubsetMatch([1, 2], [1, 2, 3])).toBe(false);
    expect(isSubsetMatch([2, 1], [1, 2])).toBe(false);
  });

  test("array vs object mismatch fails", () => {
    expect(isSubsetMatch([1], { 0: 1 })).toBe(false);
  });

  test("type mismatch fails", () => {
    expect(isSubsetMatch("42", 42)).toBe(false);
    expect(isSubsetMatch({}, null)).toBe(false);
  });

  test("empty expected matches any object", () => {
    expect(isSubsetMatch({ a: 1, b: 2 }, {})).toBe(true);
  });
});

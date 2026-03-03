import { describe, expect, test } from "bun:test";
import { deepMerge } from "./merge.js";

describe("deepMerge", () => {
  test("returns base when override is empty", () => {
    const base = { a: 1, b: "hello" };
    const result = deepMerge(base, {});
    expect(result).toEqual({ a: 1, b: "hello" });
  });

  test("does not mutate base or override", () => {
    const base = { a: 1, nested: { x: 10 } };
    const override = { a: 2 };
    const baseCopy = JSON.parse(JSON.stringify(base));
    const overrideCopy = JSON.parse(JSON.stringify(override));
    deepMerge(base, override);
    expect(base).toEqual(baseCopy);
    expect(override).toEqual(overrideCopy);
  });

  test("overrides primitives", () => {
    const result = deepMerge({ a: 1, b: "old" }, { b: "new" });
    expect(result).toEqual({ a: 1, b: "new" });
  });

  test("recursively merges nested plain objects", () => {
    const base = { nested: { x: 1, y: 2 } };
    const override: Partial<typeof base> = { nested: { x: 1, y: 99 } };
    const result = deepMerge(base, override);
    expect(result).toEqual({ nested: { x: 1, y: 99 } });
  });

  test("replaces arrays wholesale (not concatenated)", () => {
    const base = { items: [1, 2, 3] };
    const override = { items: [4, 5] };
    const result = deepMerge(base, override);
    expect(result).toEqual({ items: [4, 5] });
  });

  test("handles deeply nested objects", () => {
    const base = { a: { b: { c: { d: 1 } } } };
    const override = { a: { b: { c: { d: 42 } } } };
    const result = deepMerge(base, override);
    expect(result).toEqual({ a: { b: { c: { d: 42 } } } });
  });

  test("override null replaces nested object", () => {
    const base = { nested: { x: 1 } } as Record<string, unknown>;
    const result = deepMerge(base, { nested: null });
    expect(result).toEqual({ nested: null });
  });

  test("does not add keys absent from base", () => {
    const base = { a: 1 };
    const result = deepMerge(base, { b: 2 } as Partial<typeof base>);
    expect(result).toEqual({ a: 1 });
  });

  test("returns a new reference even with no overrides", () => {
    const base = { a: 1 };
    const result = deepMerge(base, {});
    expect(result).not.toBe(base);
  });

  test("preserves boolean false as valid override", () => {
    const base = { enabled: true };
    const result = deepMerge(base, { enabled: false });
    expect(result).toEqual({ enabled: false });
  });
});

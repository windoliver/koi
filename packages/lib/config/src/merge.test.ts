import { describe, expect, test } from "bun:test";
import { deepMerge } from "./merge.js";

describe("deepMerge", () => {
  test("merges flat objects", () => {
    const result = deepMerge({ a: 1, b: 2 } as Record<string, unknown>, { b: 3, c: 4 });
    expect(result).toEqual({ a: 1, b: 3, c: 4 });
  });

  test("merges nested objects recursively", () => {
    const result = deepMerge({ nested: { a: 1, b: 2 } } as Record<string, unknown>, {
      nested: { b: 3, c: 4 },
    });
    expect(result).toEqual({ nested: { a: 1, b: 3, c: 4 } });
  });

  test("replaces arrays wholesale (no concat)", () => {
    const result = deepMerge({ items: [1, 2, 3] } as Record<string, unknown>, { items: [4, 5] });
    expect(result).toEqual({ items: [4, 5] });
  });

  test("override primitive replaces base object", () => {
    const result = deepMerge({ key: { nested: true } } as Record<string, unknown>, { key: "flat" });
    expect(result).toEqual({ key: "flat" });
  });

  test("override object replaces base primitive", () => {
    const result = deepMerge({ key: "flat" } as Record<string, unknown>, { key: { nested: true } });
    expect(result).toEqual({ key: { nested: true } });
  });

  test("does not mutate base", () => {
    const base: Record<string, unknown> = { a: 1, nested: { b: 2 } };
    const original = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
    deepMerge(base, { a: 99, nested: { c: 3 } });
    expect(base).toEqual(original);
  });

  test("filters __proto__ key", () => {
    const base: Record<string, unknown> = { safe: true };
    const override = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}') as Record<
      string,
      unknown
    >;
    const result = deepMerge(base, override);
    expect(result).toEqual({ safe: true, ok: 1 });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("filters constructor key", () => {
    const result = deepMerge({ safe: true } as Record<string, unknown>, { constructor: "bad" });
    expect(result).toEqual({ safe: true });
  });

  test("filters prototype key", () => {
    const result = deepMerge({ safe: true } as Record<string, unknown>, { prototype: "bad" });
    expect(result).toEqual({ safe: true });
  });

  test("handles empty override", () => {
    const base: Record<string, unknown> = { a: 1, b: 2 };
    const result = deepMerge(base, {});
    expect(result).toEqual({ a: 1, b: 2 });
  });
});

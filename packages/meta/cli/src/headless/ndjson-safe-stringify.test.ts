import { describe, expect, test } from "bun:test";
import { ndjsonSafeStringify } from "./ndjson-safe-stringify.js";

describe("ndjsonSafeStringify", () => {
  test("produces single-line JSON for simple object", () => {
    expect(ndjsonSafeStringify({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
  });

  test("escapes U+2028 (line separator)", () => {
    const s = ndjsonSafeStringify({ text: "before\u2028after" });
    expect(s).not.toContain("\u2028");
    expect(s).toContain("\\u2028");
  });

  test("escapes U+2029 (paragraph separator)", () => {
    const s = ndjsonSafeStringify({ text: "before\u2029after" });
    expect(s).not.toContain("\u2029");
    expect(s).toContain("\\u2029");
  });

  test("escapes raw newlines in strings", () => {
    const s = ndjsonSafeStringify({ text: "a\nb" });
    expect(s.split("\n").length).toBe(1);
  });

  test("returns stable output across calls", () => {
    const obj = { a: 1, b: 2 };
    expect(ndjsonSafeStringify(obj)).toBe(ndjsonSafeStringify(obj));
  });

  test("handles circular references without throwing", () => {
    const obj: { readonly a: number; self?: unknown } = { a: 1 };
    obj.self = obj;
    const s = ndjsonSafeStringify(obj);
    expect(s).toContain('"a":1');
    expect(s).toContain("[Circular]");
    expect(() => JSON.parse(s)).not.toThrow();
  });

  test("handles BigInt by serializing as string", () => {
    const s = ndjsonSafeStringify({ big: 9007199254740993n });
    expect(s).toContain('"9007199254740993"');
    expect(() => JSON.parse(s)).not.toThrow();
  });

  test("handles functions with a placeholder", () => {
    const s = ndjsonSafeStringify({ fn: function named() {} });
    expect(s).toContain("[Function: named]");
    expect(() => JSON.parse(s)).not.toThrow();
  });

  test("falls back to a redacted envelope when serialization genuinely fails", () => {
    // JSON.stringify with a replacer that itself throws cannot be recovered —
    // simulate by passing a value whose toJSON throws.
    const bad = {
      toJSON(): never {
        throw new Error("cannot serialize");
      },
    };
    const s = ndjsonSafeStringify(bad);
    const parsed = JSON.parse(s);
    expect(parsed).toMatchObject({ __unserialiable: true });
    expect(parsed.error).toContain("cannot serialize");
  });
});

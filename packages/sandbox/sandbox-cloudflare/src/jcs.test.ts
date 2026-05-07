import { describe, expect, it } from "bun:test";

import { jcsCanonicalise } from "./jcs.js";

describe("jcsCanonicalise", () => {
  it("produces identical output regardless of object-key order", () => {
    expect(jcsCanonicalise({ a: 1, b: 2 })).toBe(jcsCanonicalise({ b: 2, a: 1 }));
  });

  it("collapses -0 and +0 to the same form", () => {
    expect(jcsCanonicalise(-0)).toBe(jcsCanonicalise(0));
  });

  it("rejects non-finite numbers per RFC 8785", () => {
    expect(() => jcsCanonicalise(Number.NaN)).toThrow();
    expect(() => jcsCanonicalise(Number.POSITIVE_INFINITY)).toThrow();
  });

  it("escapes control characters and quote characters", () => {
    expect(jcsCanonicalise("a\nb")).toBe('"a\\nb"');
    expect(jcsCanonicalise('a"b')).toBe('"a\\"b"');
    expect(jcsCanonicalise("")).toBe('"\\u0001"');
    expect(jcsCanonicalise("")).toBe('""');
  });

  it("preserves array order", () => {
    expect(jcsCanonicalise([3, 1, 2])).toBe("[3,1,2]");
  });

  it("emits null/booleans verbatim", () => {
    expect(jcsCanonicalise(null)).toBe("null");
    expect(jcsCanonicalise(true)).toBe("true");
    expect(jcsCanonicalise(false)).toBe("false");
  });
});

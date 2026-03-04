import { describe, expect, test } from "bun:test";
import { canonicalize, sortKeys } from "./canonicalize.js";

describe("sortKeys", () => {
  test("returns primitives unchanged", () => {
    expect(sortKeys(42)).toBe(42);
    expect(sortKeys("hello")).toBe("hello");
    expect(sortKeys(null)).toBeNull();
    expect(sortKeys(true)).toBe(true);
  });

  test("sorts object keys lexicographically", () => {
    const result = sortKeys({ b: 2, a: 1 });
    expect(Object.keys(result as Record<string, unknown>)).toEqual(["a", "b"]);
  });

  test("sorts nested object keys recursively", () => {
    const result = sortKeys({ z: { b: 2, a: 1 }, a: 0 });
    const str = JSON.stringify(result);
    expect(str).toBe('{"a":0,"z":{"a":1,"b":2}}');
  });

  test("processes arrays element-wise", () => {
    const result = sortKeys([
      { b: 2, a: 1 },
      { d: 4, c: 3 },
    ]);
    const str = JSON.stringify(result);
    expect(str).toBe('[{"a":1,"b":2},{"c":3,"d":4}]');
  });
});

describe("canonicalize", () => {
  test("produces deterministic JSON regardless of insertion order", () => {
    const a = canonicalize({ b: 2, a: 1 } as Record<string, unknown>);
    const b = canonicalize({ a: 1, b: 2 } as Record<string, unknown>);
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  test("handles nested objects deterministically", () => {
    const result = canonicalize({
      scope: { permissions: { deny: ["rm"], allow: ["read"] } },
      id: "abc",
    } as Record<string, unknown>);
    expect(result).toBe('{"id":"abc","scope":{"permissions":{"allow":["read"],"deny":["rm"]}}}');
  });

  test("handles empty object", () => {
    expect(canonicalize({})).toBe("{}");
  });

  test("cross-implementation vector: identical to JSON.stringify with pre-sorted keys", () => {
    const obj = { z: 1, m: [{ b: "B", a: "A" }], a: { c: 3, b: 2 } } as Record<string, unknown>;
    const canonical = canonicalize(obj);
    expect(canonical).toBe('{"a":{"b":2,"c":3},"m":[{"a":"A","b":"B"}],"z":1}');
  });
});

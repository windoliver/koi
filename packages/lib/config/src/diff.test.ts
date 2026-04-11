import { describe, expect, test } from "bun:test";
import { diffConfig } from "./diff.js";

describe("diffConfig", () => {
  test("returns empty for identical primitives", () => {
    expect(diffConfig(1, 1)).toEqual([]);
    expect(diffConfig("a", "a")).toEqual([]);
    expect(diffConfig(true, true)).toEqual([]);
    expect(diffConfig(null, null)).toEqual([]);
  });

  test("returns empty for deeply-equal plain objects", () => {
    const a = { x: 1, y: { z: 2 } };
    const b = { x: 1, y: { z: 2 } };
    expect(diffConfig(a, b)).toEqual([]);
  });

  test("reports differing primitive at root", () => {
    expect(diffConfig(1, 2)).toEqual([""]);
  });

  test("reports differing leaf key", () => {
    expect(diffConfig({ x: 1 }, { x: 2 })).toEqual(["x"]);
  });

  test("reports nested dot-path", () => {
    expect(diffConfig({ a: { b: { c: 1 } } }, { a: { b: { c: 2 } } })).toEqual(["a.b.c"]);
  });

  test("reports multiple paths", () => {
    const prev = { a: 1, b: { c: 2, d: 3 } };
    const next = { a: 99, b: { c: 2, d: 4 } };
    expect(diffConfig(prev, next)).toEqual(["a", "b.d"]);
  });

  test("reports keys that exist only on one side", () => {
    expect(diffConfig({ a: 1 }, { a: 1, b: 2 })).toEqual(["b"]);
    expect(diffConfig({ a: 1, b: 2 }, { a: 1 })).toEqual(["b"]);
  });

  test("arrays are compared as whole units — any change reports the array path", () => {
    expect(diffConfig({ xs: [1, 2, 3] }, { xs: [1, 2, 4] })).toEqual(["xs"]);
    expect(diffConfig({ xs: [1, 2, 3] }, { xs: [1, 2] })).toEqual(["xs"]);
    expect(diffConfig({ xs: [1, 2, 3] }, { xs: [1, 2, 3] })).toEqual([]);
  });

  test("array of objects: structural equality", () => {
    const prev = { targets: [{ provider: "a", model: "m1" }] };
    const next = { targets: [{ provider: "a", model: "m1" }] };
    expect(diffConfig(prev, next)).toEqual([]);
  });

  test("array of objects: element change reports only the array path", () => {
    const prev = { targets: [{ provider: "a", model: "m1" }] };
    const next = { targets: [{ provider: "a", model: "m2" }] };
    expect(diffConfig(prev, next)).toEqual(["targets"]);
  });

  test("paths are deduplicated and sorted", () => {
    const prev = { z: 1, a: 1, m: { y: 1, x: 1 } };
    const next = { z: 2, a: 2, m: { y: 2, x: 2 } };
    expect(diffConfig(prev, next)).toEqual(["a", "m.x", "m.y", "z"]);
  });

  test("handles NaN correctly (Object.is)", () => {
    expect(diffConfig({ x: Number.NaN }, { x: Number.NaN })).toEqual([]);
  });

  test("ignores prototype / class instances — treats them as changed leaves", () => {
    class Foo {
      readonly value = 1;
    }
    const result = diffConfig({ x: new Foo() }, { x: new Foo() });
    // Class instances are non-plain; fall through to deepEqual which returns false for different refs
    // Same-shape class instances: deepEqual path works for plain comparison but we only walk plain objects.
    // The two new Foo() instances compare as "changed" under our semantics.
    expect(result).toEqual(["x"]);
  });

  test("distinguishes null from undefined", () => {
    expect(diffConfig({ x: null }, { x: undefined })).toEqual(["x"]);
  });
});

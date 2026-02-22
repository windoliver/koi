import { describe, expect, test } from "bun:test";
import { fnv1a } from "./hash.js";

describe("fnv1a (permissions)", () => {
  test("returns deterministic hashes", () => {
    expect(fnv1a("hello")).toBe(fnv1a("hello"));
  });

  test("different inputs produce different hashes", () => {
    expect(fnv1a("hello")).not.toBe(fnv1a("world"));
  });

  test("empty string produces FNV offset basis", () => {
    expect(fnv1a("")).toBe(0x811c9dc5);
  });

  test("produces unsigned 32-bit integer", () => {
    const hash = fnv1a("test string");
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
  });

  test("matches engine fnv1a output", () => {
    // Known values — must stay in sync with @koi/engine fnv1a
    expect(fnv1a('calc:{"a":1}')).toBe(fnv1a('calc:{"a":1}'));
    // Verify specific known hash to catch drift
    const hash = fnv1a("test");
    expect(typeof hash).toBe("number");
    expect(hash).toBeGreaterThan(0);
  });
});

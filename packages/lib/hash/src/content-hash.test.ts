import { describe, expect, test } from "bun:test";
import { computeContentHash, computeStringHash } from "./content-hash.js";

describe("computeContentHash", () => {
  test("same data different key order produces same hash", () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  test("nested objects are sorted recursively", () => {
    const a = { outer: { z: 1, a: 2 }, x: true };
    const b = { x: true, outer: { a: 2, z: 1 } };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });

  test("arrays preserve element order", () => {
    const a = [1, 2, 3];
    const b = [3, 2, 1];
    expect(computeContentHash(a)).not.toBe(computeContentHash(b));
  });

  test("different data produces different hashes", () => {
    expect(computeContentHash({ a: 1 })).not.toBe(computeContentHash({ a: 2 }));
  });

  test("primitives hash correctly", () => {
    const strHash = computeContentHash("hello");
    const numHash = computeContentHash(42);
    const boolHash = computeContentHash(true);
    expect(strHash).not.toBe(numHash);
    expect(numHash).not.toBe(boolHash);
  });

  test("null and undefined produce distinct hashes", () => {
    expect(computeContentHash(null)).not.toBe(computeContentHash(undefined));
  });

  test("empty object produces consistent hash", () => {
    const hash1 = computeContentHash({});
    const hash2 = computeContentHash({});
    expect(hash1).toBe(hash2);
  });

  test("empty string produces consistent hash", () => {
    const hash1 = computeContentHash("");
    const hash2 = computeContentHash("");
    expect(hash1).toBe(hash2);
  });

  test("unicode content hashes consistently", () => {
    const data = { name: "工具-名前-도구", emoji: "🤖" };
    const hash1 = computeContentHash(data);
    const hash2 = computeContentHash(data);
    expect(hash1).toBe(hash2);
  });

  test("returns 64-character hex digest", () => {
    const hash = computeContentHash({ test: true });
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("deeply nested objects are sorted at all levels", () => {
    const a = { l1: { l2: { z: "deep", a: "deeper" } } };
    const b = { l1: { l2: { a: "deeper", z: "deep" } } };
    expect(computeContentHash(a)).toBe(computeContentHash(b));
  });
});

describe("computeStringHash", () => {
  test("returns 64-character hex digest", () => {
    const hash = computeStringHash("hello world");
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  test("same input produces same hash", () => {
    expect(computeStringHash("test")).toBe(computeStringHash("test"));
  });

  test("different inputs produce different hashes", () => {
    expect(computeStringHash("a")).not.toBe(computeStringHash("b"));
  });

  test("empty string produces consistent hash", () => {
    const hash1 = computeStringHash("");
    const hash2 = computeStringHash("");
    expect(hash1).toBe(hash2);
  });

  test("hashes raw string without JSON serialization", () => {
    // computeContentHash wraps strings in JSON.stringify (adds quotes)
    // computeStringHash hashes the raw string — they must differ
    expect(computeStringHash("hello")).not.toBe(computeContentHash("hello"));
  });

  test("unicode content hashes consistently", () => {
    const hash1 = computeStringHash("工具-名前-도구 🤖");
    const hash2 = computeStringHash("工具-名前-도구 🤖");
    expect(hash1).toBe(hash2);
  });
});

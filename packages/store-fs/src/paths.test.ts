import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { brickPath, shardDir, shardPrefix, tmpPath } from "./paths.js";

describe("shardPrefix", () => {
  test("extracts first two chars lowercased", () => {
    expect(shardPrefix("abc123")).toBe("ab");
    expect(shardPrefix("XYZ789")).toBe("xy");
  });

  test("returns 'xx' for short IDs", () => {
    expect(shardPrefix("ab")).toBe("xx");
    expect(shardPrefix("a")).toBe("xx");
    expect(shardPrefix("")).toBe("xx");
  });

  test("handles numeric prefixes", () => {
    expect(shardPrefix("99brick")).toBe("99");
  });
});

describe("brickPath", () => {
  test("produces <baseDir>/<shard>/<id>.json", () => {
    expect(brickPath("/store", "abc123")).toBe(join("/store", "ab", "abc123.json"));
  });
});

describe("tmpPath", () => {
  test("produces <baseDir>/<shard>/<id>.<random>.tmp", () => {
    const result = tmpPath("/store", "abc123");
    expect(result).toStartWith(join("/store", "ab", "abc123."));
    expect(result).toEndWith(".tmp");
  });

  test("produces unique paths on successive calls", () => {
    const a = tmpPath("/store", "abc123");
    const b = tmpPath("/store", "abc123");
    expect(a).not.toBe(b);
  });
});

describe("shardDir", () => {
  test("produces <baseDir>/<shard>", () => {
    expect(shardDir("/store", "abc123")).toBe(join("/store", "ab"));
  });
});

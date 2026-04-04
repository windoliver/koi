import { describe, expect, test } from "bun:test";
import type { MemoryRecord } from "@koi/core/memory";
import { memoryRecordId } from "@koi/core/memory";
import { findDuplicate, jaccard, tokenize } from "./dedup.js";

describe("tokenize", () => {
  test("splits Latin text into lowercase words", () => {
    const tokens = tokenize("Hello World");
    expect(tokens).toEqual(new Set(["hello", "world"]));
  });

  test("returns empty set for empty string", () => {
    expect(tokenize("").size).toBe(0);
  });

  test("uses character bigrams for CJK text", () => {
    const tokens = tokenize("\u4f60\u597d\u4e16\u754c");
    expect(tokens.has("\u4f60\u597d")).toBe(true);
    expect(tokens.has("\u597d\u4e16")).toBe(true);
    expect(tokens.has("\u4e16\u754c")).toBe(true);
    expect(tokens.size).toBe(3);
  });

  test("handles single CJK character", () => {
    const tokens = tokenize("\u4f60");
    expect(tokens.size).toBe(1);
    expect(tokens.has("\u4f60")).toBe(true);
  });
});

describe("jaccard", () => {
  test("returns 1 for identical strings", () => {
    expect(jaccard("hello world", "hello world")).toBe(1);
  });

  test("returns 0 for completely different strings", () => {
    expect(jaccard("hello world", "foo bar")).toBe(0);
  });

  test("returns 1 for two empty strings", () => {
    expect(jaccard("", "")).toBe(1);
  });

  test("returns 0 when one string is empty", () => {
    expect(jaccard("hello", "")).toBe(0);
  });

  test("returns partial similarity for overlapping content", () => {
    const sim = jaccard("the quick brown fox", "the quick red fox");
    expect(sim).toBeGreaterThan(0);
    expect(sim).toBeLessThan(1);
  });

  test("is case insensitive", () => {
    expect(jaccard("Hello World", "hello world")).toBe(1);
  });
});

function makeRecord(id: string, content: string): MemoryRecord {
  return {
    id: memoryRecordId(id),
    name: id,
    description: "test",
    type: "user",
    content,
    filePath: `${id}.md`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe("findDuplicate", () => {
  test("returns match above threshold", () => {
    const existing = [makeRecord("r1", "the user prefers dark mode")];
    const result = findDuplicate("the user prefers dark mode", existing, 0.7);
    expect(result).toBeDefined();
    expect(result?.id).toBe(memoryRecordId("r1"));
    expect(result?.similarity).toBe(1);
  });

  test("returns undefined below threshold", () => {
    const existing = [makeRecord("r1", "the user prefers dark mode")];
    const result = findDuplicate("completely different content here", existing, 0.7);
    expect(result).toBeUndefined();
  });

  test("returns best match when multiple exist", () => {
    const existing = [
      makeRecord("r1", "user likes dark mode in editors"),
      makeRecord("r2", "user likes dark mode"),
    ];
    const result = findDuplicate("user likes dark mode", existing, 0.7);
    expect(result?.id).toBe(memoryRecordId("r2"));
  });

  test("returns undefined for empty list", () => {
    expect(findDuplicate("anything", [], 0.7)).toBeUndefined();
  });
});

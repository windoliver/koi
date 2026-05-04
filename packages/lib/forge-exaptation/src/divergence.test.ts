import { describe, expect, test } from "bun:test";
import { computeJaccardDistance, tokenize } from "./divergence.js";

describe("tokenize", () => {
  test("lowercases, splits on non-word chars, drops short tokens and stopwords", () => {
    const tokens = tokenize("Read THE files from the filesystem.");
    expect([...tokens].sort()).toEqual(["files", "filesystem", "read"]);
  });

  test("returns empty set for empty input", () => {
    expect(tokenize("").size).toBe(0);
  });
});

describe("computeJaccardDistance", () => {
  test("returns 0 when identical", () => {
    const a = tokenize("read files filesystem");
    const b = tokenize("read files filesystem");
    expect(computeJaccardDistance(a, b)).toBe(0);
  });

  test("returns 1 when fully disjoint", () => {
    const a = tokenize("alpha beta gamma");
    const b = tokenize("delta epsilon zeta");
    expect(computeJaccardDistance(a, b)).toBe(1);
  });

  test("returns 0 for two empty sets (no signal)", () => {
    expect(computeJaccardDistance(new Set(), new Set())).toBe(0);
  });

  test("partial overlap is between 0 and 1", () => {
    const a = tokenize("read files config");
    const b = tokenize("read network packets");
    const d = computeJaccardDistance(a, b);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });
});

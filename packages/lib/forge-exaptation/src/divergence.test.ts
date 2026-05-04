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

  test("splits snake_case into individual words", () => {
    expect([...tokenize("read_file_contents")].sort()).toEqual(["contents", "file", "read"]);
  });

  test("splits camelCase into individual words", () => {
    expect([...tokenize("readFileContents")].sort()).toEqual(["contents", "file", "read"]);
  });

  test("splits PascalCase + acronyms cleanly", () => {
    expect([...tokenize("HTTPRequestHandler")].sort()).toEqual(["handler", "http", "request"]);
  });

  test("splits hyphenated identifiers", () => {
    expect([...tokenize("parse-json-config")].sort()).toEqual(["config", "json", "parse"]);
  });

  test("snake_case and camelCase tokenize identically", () => {
    expect([...tokenize("parse_json_config")].sort()).toEqual(
      [...tokenize("parseJsonConfig")].sort(),
    );
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

  test("returns NaN when either set is empty (no lexical signal)", () => {
    expect(computeJaccardDistance(new Set(), new Set())).toBeNaN();
    expect(computeJaccardDistance(new Set(["a", "b"]), new Set())).toBeNaN();
    expect(computeJaccardDistance(new Set(), new Set(["a", "b"]))).toBeNaN();
  });

  test("partial overlap is between 0 and 1", () => {
    const a = tokenize("read files config");
    const b = tokenize("read network packets");
    const d = computeJaccardDistance(a, b);
    expect(d).toBeGreaterThan(0);
    expect(d).toBeLessThan(1);
  });
});

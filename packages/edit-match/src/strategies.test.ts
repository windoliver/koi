import { describe, expect, test } from "bun:test";
import {
  matchExact,
  matchFuzzy,
  matchIndentationFlexible,
  matchWhitespaceNormalized,
} from "./strategies.js";

describe("matchExact", () => {
  test("finds exact substring match", () => {
    const source = "function foo() {\n  return 1;\n}";
    const search = "return 1;";
    const result = matchExact(source, search);
    expect(result).toBeDefined();
    expect(result?.strategy).toBe("exact");
    expect(result?.confidence).toBe(1.0);
    expect(source.slice(result?.startIndex, result?.endIndex)).toBe(search);
  });

  test("returns undefined when no match", () => {
    expect(matchExact("hello world", "xyz")).toBeUndefined();
  });

  test("returns undefined for ambiguous (duplicate) matches", () => {
    const source = "foo bar foo";
    expect(matchExact(source, "foo")).toBeUndefined();
  });

  test("handles multi-line search", () => {
    const source = "a\nb\nc\nd";
    const search = "b\nc";
    const result = matchExact(source, search);
    expect(result).toBeDefined();
    expect(source.slice(result?.startIndex, result?.endIndex)).toBe("b\nc");
  });
});

describe("matchWhitespaceNormalized", () => {
  test("matches when only whitespace differs", () => {
    const source = "function  foo()  {\n  return   1;\n}";
    const search = "function foo() {\n  return 1;\n}";
    const result = matchWhitespaceNormalized(source, search);
    expect(result).toBeDefined();
    expect(result?.strategy).toBe("whitespace-normalized");
    expect(result?.confidence).toBe(0.95);
  });

  test("returns undefined when content differs", () => {
    const source = "function foo() { return 1; }";
    const search = "function bar() { return 2; }";
    expect(matchWhitespaceNormalized(source, search)).toBeUndefined();
  });

  test("returns undefined for ambiguous matches", () => {
    const source = "return 1;\nreturn 1;";
    const search = "return 1;";
    expect(matchWhitespaceNormalized(source, search)).toBeUndefined();
  });

  test("returns undefined for empty search", () => {
    expect(matchWhitespaceNormalized("hello", "")).toBeUndefined();
    expect(matchWhitespaceNormalized("hello", "   ")).toBeUndefined();
  });
});

describe("matchIndentationFlexible", () => {
  test("matches with different indentation levels", () => {
    const source = "  function foo() {\n    return 1;\n  }";
    const search = "function foo() {\n  return 1;\n}";
    const result = matchIndentationFlexible(source, search);
    expect(result).toBeDefined();
    expect(result?.strategy).toBe("indentation-flexible");
    expect(result?.confidence).toBe(0.9);
  });

  test("returns undefined when content differs", () => {
    const source = "  function foo() {\n    return 1;\n  }";
    const search = "function bar() {\n  return 2;\n}";
    expect(matchIndentationFlexible(source, search)).toBeUndefined();
  });

  test("returns undefined for ambiguous matches", () => {
    const source = "  return 1;\n  return 1;";
    const search = "return 1;";
    expect(matchIndentationFlexible(source, search)).toBeUndefined();
  });
});

describe("matchFuzzy", () => {
  test("matches with small edits", () => {
    const source = "function hello() {\n  return 'world';\n}";
    const search = "function hello() {\n  return 'worl';\n}";
    const result = matchFuzzy(source, search);
    expect(result).toBeDefined();
    expect(result?.strategy).toBe("fuzzy");
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("returns undefined when too different", () => {
    const source = "completely different content here that is very long";
    const search = "nothing even remotely similar to this text at all now";
    expect(matchFuzzy(source, search)).toBeUndefined();
  });

  test("returns undefined for empty search", () => {
    expect(matchFuzzy("hello world", "")).toBeUndefined();
  });
});

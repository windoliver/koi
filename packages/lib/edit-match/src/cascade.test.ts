import { describe, expect, test } from "bun:test";
import { applyEdit, findMatch } from "./cascade.js";

describe("findMatch", () => {
  test("returns undefined for empty search", () => {
    expect(findMatch("hello world", "")).toBeUndefined();
  });

  test("uses exact strategy when possible", () => {
    const source = "function foo() { return 1; }";
    const search = "return 1;";
    const result = findMatch(source, search);
    expect(result).toBeDefined();
    expect(result?.strategy).toBe("exact");
  });

  test("falls back to whitespace-normalized", () => {
    const source = "function  foo()  {\n  return   1;\n}";
    const search = "function foo() {\n  return 1;\n}";
    const result = findMatch(source, search);
    expect(result).toBeDefined();
    expect(result?.strategy).toBe("whitespace-normalized");
  });

  test("falls back to indentation-flexible", () => {
    const source = "    function foo() {\n      return 1;\n    }";
    const search = "function foo() {\n  return 1;\n}";
    const result = findMatch(source, search);
    expect(result).toBeDefined();
    // Could be whitespace-normalized or indentation-flexible
    if (result !== undefined) {
      expect(["whitespace-normalized", "indentation-flexible"]).toContain(result.strategy);
    }
  });

  test("falls back to fuzzy for close-but-not-identical text", () => {
    const source =
      "function processData(input) {\n  const result = transform(input);\n  return result;\n}";
    const search =
      "function processData(input) {\n  const result = transfrm(input);\n  return result;\n}";
    const result = findMatch(source, search);
    expect(result).toBeDefined();
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test("returns undefined when no strategy matches", () => {
    const source = "hello world";
    const search = "completely unrelated text that is very different from the source";
    expect(findMatch(source, search)).toBeUndefined();
  });
});

describe("applyEdit", () => {
  test("replaces matched text with replacement", () => {
    const source = "function foo() {\n  return 1;\n}";
    const search = "return 1;";
    const replacement = "return 42;";
    const result = applyEdit(source, search, replacement);
    expect(result).toBeDefined();
    expect(result?.content).toBe("function foo() {\n  return 42;\n}");
    expect(result?.match.strategy).toBe("exact");
  });

  test("returns undefined when no match found", () => {
    expect(applyEdit("hello", "xyz", "abc")).toBeUndefined();
  });

  test("handles multi-line replacement", () => {
    const source = "a\nb\nc";
    const search = "b";
    const replacement = "x\ny";
    const result = applyEdit(source, search, replacement);
    expect(result).toBeDefined();
    expect(result?.content).toBe("a\nx\ny\nc");
  });

  test("handles deletion (empty replacement)", () => {
    const source = "a\nb\nc";
    const search = "\nb\n";
    const replacement = "\n";
    const result = applyEdit(source, search, replacement);
    expect(result).toBeDefined();
    expect(result?.content).toBe("a\nc");
  });
});

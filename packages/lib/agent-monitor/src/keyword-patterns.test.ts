import { describe, expect, test } from "bun:test";
import { buildKeywordPatterns } from "./keyword-patterns.js";

describe("buildKeywordPatterns", () => {
  test("splits on non-word, lowercases, removes stopwords/short, dedupes", () => {
    const patterns = buildKeywordPatterns([
      "search the web for recent papers",
      "write a literature review",
    ]);
    const sources = patterns.map((p) => p.source).sort();
    expect(sources).toEqual(
      ["literature", "papers", "recent", "review", "search", "web", "write"].sort(),
    );
  });

  test("returns empty for empty objectives", () => {
    expect(buildKeywordPatterns([])).toEqual([]);
    expect(buildKeywordPatterns([""])).toEqual([]);
  });

  test("matches case-insensitively", () => {
    const [p] = buildKeywordPatterns(["search the web"]);
    expect(p?.test("WEB_SEARCH")).toBe(true);
  });

  test("filters words ≤2 chars", () => {
    const patterns = buildKeywordPatterns(["go do it now"]);
    expect(patterns.map((p) => p.source).sort()).toEqual(["now"]);
  });
});

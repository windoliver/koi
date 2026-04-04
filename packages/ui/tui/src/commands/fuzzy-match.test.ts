import { describe, expect, test } from "bun:test";
import { fuzzyFilter, fuzzyScore } from "./fuzzy-match.js";

// ---------------------------------------------------------------------------
// fuzzyScore
// ---------------------------------------------------------------------------

describe("fuzzyScore", () => {
  test("empty query matches everything with score 1", () => {
    expect(fuzzyScore("anything", "")).toBe(1);
    expect(fuzzyScore("", "")).toBe(1);
  });

  test("exact match scores higher than partial subsequence", () => {
    const exact = fuzzyScore("clear", "clear");
    const partial = fuzzyScore("clear history", "clear");
    expect(exact).toBeGreaterThan(0);
    expect(partial).toBeGreaterThan(0);
    // Exact prefix match: every char is consecutive → max bonus
    expect(exact).toBeGreaterThanOrEqual(partial);
  });

  test("no match returns 0", () => {
    expect(fuzzyScore("sessions", "xyz")).toBe(0);
    expect(fuzzyScore("clear", "zzz")).toBe(0);
  });

  test("case-insensitive: uppercase query matches lowercase label", () => {
    expect(fuzzyScore("agent", "AG")).toBeGreaterThan(0);
    expect(fuzzyScore("Agent", "ag")).toBeGreaterThan(0);
  });

  test("subsequence match: non-consecutive chars in order", () => {
    // 'n' and 's' appear in "new-session" in order
    expect(fuzzyScore("new-session", "ns")).toBeGreaterThan(0);
    // 'q' and 't' appear in "quit" in order
    expect(fuzzyScore("quit", "qt")).toBeGreaterThan(0);
  });

  test("query longer than label returns 0", () => {
    expect(fuzzyScore("ab", "abcdef")).toBe(0);
    expect(fuzzyScore("", "x")).toBe(0);
  });

  test("consecutive chars score higher than spread chars", () => {
    // "cl" in "clear" — consecutive from start — should score higher than
    // "cl" in "c---l" (spread apart)
    const consecutive = fuzzyScore("clear", "cl");
    const spread = fuzzyScore("cancel", "cl"); // c...l separated
    expect(consecutive).toBeGreaterThan(spread);
  });

  test("single character query matches if char exists", () => {
    expect(fuzzyScore("sessions", "s")).toBeGreaterThan(0);
    expect(fuzzyScore("sessions", "z")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// fuzzyFilter
// ---------------------------------------------------------------------------

describe("fuzzyFilter", () => {
  const ITEMS = ["clear", "compact", "sessions", "new-session", "quit", "help"];
  const getLabel = (s: string): string => s;

  test("empty query returns all items unchanged", () => {
    const result = fuzzyFilter(ITEMS, "", getLabel);
    expect(result).toEqual(ITEMS);
  });

  test("empty items array returns empty array", () => {
    expect(fuzzyFilter([], "cl", getLabel)).toEqual([]);
  });

  test("filters out non-matching items", () => {
    const result = fuzzyFilter(ITEMS, "xyz", getLabel);
    expect(result).toHaveLength(0);
  });

  test("returns matching items sorted by score descending", () => {
    // "cl" should match "clear" (consecutive) and "cancel" (spread) if present
    const items = ["c_l_e_a_r", "clear"];
    const result = fuzzyFilter(items, "cl", getLabel);
    expect(result[0]).toBe("clear"); // consecutive wins
  });

  test("exact prefix match ranks first", () => {
    const result = fuzzyFilter(ITEMS, "se", getLabel);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toBe("sessions"); // starts with "se"
  });

  test("does not mutate the original items array", () => {
    const copy = [...ITEMS];
    fuzzyFilter(ITEMS, "cl", getLabel);
    expect(ITEMS).toEqual(copy);
  });
});

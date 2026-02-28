import { describe, expect, test } from "bun:test";
import { truncateToTokenBudget } from "./tokens.js";

// estimateTokens and CHARS_PER_TOKEN are re-exports from @koi/token-estimator;
// canonical tests live there — only truncation logic is tested here.

describe("truncateToTokenBudget", () => {
  test("returns text unchanged when within budget", () => {
    const result = truncateToTokenBudget("short", 100, "test");
    expect(result.text).toBe("short");
    expect(result.warning).toBeUndefined();
  });

  test("truncates text exceeding budget", () => {
    // 10 tokens * 4 chars = 40 chars max
    const result = truncateToTokenBudget("A".repeat(100), 10, "test");
    expect(result.text.length).toBe(40);
    expect(result.warning).toBeDefined();
  });

  test("warning includes label", () => {
    const result = truncateToTokenBudget("A".repeat(100), 10, "soul");
    expect(result.warning).toContain("soul");
  });

  test("warning includes token counts", () => {
    const result = truncateToTokenBudget("A".repeat(100), 10, "test");
    expect(result.warning).toContain("truncated");
    expect(result.warning).toContain("10");
  });

  test("exact boundary — no truncation", () => {
    // Exactly 40 chars = 10 tokens
    const result = truncateToTokenBudget("A".repeat(40), 10, "test");
    expect(result.text.length).toBe(40);
    expect(result.warning).toBeUndefined();
  });

  test("one char over boundary — truncates", () => {
    const result = truncateToTokenBudget("A".repeat(41), 10, "test");
    expect(result.text.length).toBe(40);
    expect(result.warning).toBeDefined();
  });
});

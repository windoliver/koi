import { describe, expect, test } from "bun:test";
import { CHARS_PER_TOKEN, estimateTokens, truncateToTokenBudget } from "./tokens.js";

describe("estimateTokens", () => {
  test("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  test("estimates at 4 chars per token (rounds up)", () => {
    // 11 chars => ceil(11/4) = 3
    expect(estimateTokens("Hello World")).toBe(3);
  });

  test("exact multiple of CHARS_PER_TOKEN", () => {
    // 8 chars => 8/4 = 2
    expect(estimateTokens("12345678")).toBe(2);
  });

  test("single character is 1 token", () => {
    expect(estimateTokens("A")).toBe(1);
  });
});

describe("CHARS_PER_TOKEN", () => {
  test("equals 4", () => {
    expect(CHARS_PER_TOKEN).toBe(4);
  });
});

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

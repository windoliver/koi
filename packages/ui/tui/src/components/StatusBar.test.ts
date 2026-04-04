import { describe, expect, test } from "bun:test";
import { formatCost, formatTokens } from "./status-bar-helpers.js";

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
  test("small numbers render as-is", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(42)).toBe("42");
    expect(formatTokens(999)).toBe("999");
  });

  test("thousands render with 'k' suffix", () => {
    expect(formatTokens(1000)).toBe("1.0k");
    expect(formatTokens(1500)).toBe("1.5k");
    expect(formatTokens(12_345)).toBe("12.3k");
    expect(formatTokens(999_999)).toBe("1000.0k");
  });

  test("millions render with 'M' suffix", () => {
    expect(formatTokens(1_000_000)).toBe("1.0M");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

// ---------------------------------------------------------------------------
// formatCost
// ---------------------------------------------------------------------------

describe("formatCost", () => {
  test("null (no cost data) renders as em-dash", () => {
    expect(formatCost(null)).toBe("—");
  });

  test("costs under $0.01 render to 4 decimal places", () => {
    expect(formatCost(0.0001)).toBe("$0.0001");
    expect(formatCost(0.005)).toBe("$0.0050");
    expect(formatCost(0.009_9)).toBe("$0.0099");
  });

  test("costs >= $0.01 render to 2 decimal places", () => {
    expect(formatCost(0.01)).toBe("$0.01");
    expect(formatCost(0.05)).toBe("$0.05");
    expect(formatCost(1.23)).toBe("$1.23");
    expect(formatCost(100)).toBe("$100.00");
  });

  test("zero cost renders as 4 decimal places (under threshold)", () => {
    expect(formatCost(0)).toBe("$0.0000");
  });
});

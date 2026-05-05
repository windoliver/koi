import { describe, expect, it } from "bun:test";
import { policyFor } from "./policy.js";

describe("policyFor", () => {
  const thresholds = {
    contextWindowTokens: 100_000,
    maxInputTokens: 100_000,
    maxChunkChars: 8_000,
  } as const;

  it("returns passthrough for inputs below the soft compaction trigger", () => {
    expect(policyFor(0, thresholds)).toBe("passthrough");
    expect(policyFor(40_000, thresholds)).toBe("passthrough");
    // 49 999 < 50% of 100k
    expect(policyFor(49_999, thresholds)).toBe("passthrough");
  });

  it("returns compact between soft and full window thresholds", () => {
    // 50% boundary maps to compact
    expect(policyFor(50_000, thresholds)).toBe("compact");
    expect(policyFor(75_000, thresholds)).toBe("compact");
    expect(policyFor(99_999, thresholds)).toBe("compact");
  });

  it("returns virtualize once input meets or exceeds maxInputTokens", () => {
    expect(policyFor(100_000, thresholds)).toBe("virtualize");
    expect(policyFor(250_000, thresholds)).toBe("virtualize");
  });

  it("never overlaps boundaries — every token count maps to exactly one disposition", () => {
    const samples = [0, 1, 49_999, 50_000, 50_001, 99_999, 100_000, 100_001, 1_000_000];
    for (const n of samples) {
      const result = policyFor(n, thresholds);
      expect(["passthrough", "compact", "virtualize"]).toContain(result);
    }
  });
});

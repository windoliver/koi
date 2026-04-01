/**
 * Policy unit tests — pure function, raw numbers.
 *
 * Tests all 5 compaction zones + boundary conditions.
 */

import { describe, expect, it } from "bun:test";
import { shouldCompact } from "./policy.js";

const WINDOW = 200_000;
const SOFT = 0.5; // 100_000 tokens
const HARD = 0.75; // 150_000 tokens

describe("shouldCompact", () => {
  // Zone 1: below soft threshold → noop
  describe("zone 1: below soft threshold", () => {
    it("returns noop for zero tokens", () => {
      expect(shouldCompact(0, WINDOW, SOFT, HARD)).toBe("noop");
    });

    it("returns noop well below soft threshold", () => {
      expect(shouldCompact(50_000, WINDOW, SOFT, HARD)).toBe("noop");
    });

    it("returns noop at 49.9% (just below soft)", () => {
      expect(shouldCompact(99_800, WINDOW, SOFT, HARD)).toBe("noop");
    });
  });

  // Zone 2: at or above soft, below hard → micro
  describe("zone 2: soft threshold to hard threshold", () => {
    it("returns micro at exactly soft threshold (50%)", () => {
      expect(shouldCompact(100_000, WINDOW, SOFT, HARD)).toBe("micro");
    });

    it("returns micro between soft and hard", () => {
      expect(shouldCompact(120_000, WINDOW, SOFT, HARD)).toBe("micro");
    });

    it("returns micro just below hard threshold", () => {
      expect(shouldCompact(149_999, WINDOW, SOFT, HARD)).toBe("micro");
    });
  });

  // Zone 3: at or above hard threshold → full
  describe("zone 3: at or above hard threshold", () => {
    it("returns full at exactly hard threshold (75%)", () => {
      expect(shouldCompact(150_000, WINDOW, SOFT, HARD)).toBe("full");
    });

    it("returns full above hard threshold", () => {
      expect(shouldCompact(180_000, WINDOW, SOFT, HARD)).toBe("full");
    });

    it("returns full at 100% capacity", () => {
      expect(shouldCompact(200_000, WINDOW, SOFT, HARD)).toBe("full");
    });

    it("returns full above 100% (overflow zone)", () => {
      expect(shouldCompact(250_000, WINDOW, SOFT, HARD)).toBe("full");
    });
  });

  // Custom thresholds
  describe("custom thresholds", () => {
    it("works with aggressive thresholds (30%/60%)", () => {
      // 30% of 200K = 60K soft, 60% of 200K = 120K hard
      expect(shouldCompact(59_999, WINDOW, 0.3, 0.6)).toBe("noop"); // just below soft
      expect(shouldCompact(60_000, WINDOW, 0.3, 0.6)).toBe("micro"); // at soft
      expect(shouldCompact(100_000, WINDOW, 0.3, 0.6)).toBe("micro"); // between
      expect(shouldCompact(120_000, WINDOW, 0.3, 0.6)).toBe("full"); // at hard
    });

    it("works with conservative thresholds (70%/90%)", () => {
      expect(shouldCompact(130_000, WINDOW, 0.7, 0.9)).toBe("noop");
      expect(shouldCompact(140_000, WINDOW, 0.7, 0.9)).toBe("micro");
      expect(shouldCompact(180_000, WINDOW, 0.7, 0.9)).toBe("full");
    });
  });

  // Edge cases
  describe("edge cases", () => {
    it("handles contextWindowSize of 0 gracefully", () => {
      // With 0 window, any tokens should trigger full
      expect(shouldCompact(0, 0, SOFT, HARD)).toBe("noop");
    });

    it("uses defaults when called with minimal args", () => {
      // Default: 200K window, 0.50 soft, 0.75 hard
      expect(shouldCompact(50_000)).toBe("noop");
      expect(shouldCompact(110_000)).toBe("micro");
      expect(shouldCompact(160_000)).toBe("full");
    });

    it("returns noop when soft equals hard (no micro zone)", () => {
      // soft === hard means micro zone is empty
      expect(shouldCompact(99_999, WINDOW, 0.5, 0.5)).toBe("noop");
      expect(shouldCompact(100_000, WINDOW, 0.5, 0.5)).toBe("full");
    });
  });
});

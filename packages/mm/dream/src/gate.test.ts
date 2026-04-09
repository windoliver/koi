import { describe, expect, test } from "bun:test";
import { shouldDream } from "./gate.js";
import { DREAM_DEFAULTS } from "./types.js";

const DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

describe("shouldDream", () => {
  test("returns true when both gates pass", () => {
    const result = shouldDream(
      { lastDreamAt: NOW - DAY_MS * 2, sessionsSinceDream: 10 },
      { now: NOW },
    );
    expect(result).toBe(true);
  });

  test("returns false when time gate fails", () => {
    const result = shouldDream(
      { lastDreamAt: NOW - DAY_MS * 0.5, sessionsSinceDream: 10 },
      { now: NOW },
    );
    expect(result).toBe(false);
  });

  test("returns false when session gate fails", () => {
    const result = shouldDream(
      { lastDreamAt: NOW - DAY_MS * 2, sessionsSinceDream: 2 },
      { now: NOW },
    );
    expect(result).toBe(false);
  });

  test("returns false when both gates fail", () => {
    const result = shouldDream(
      { lastDreamAt: NOW - DAY_MS * 0.5, sessionsSinceDream: 2 },
      { now: NOW },
    );
    expect(result).toBe(false);
  });

  test("returns true for first dream (lastDreamAt = 0)", () => {
    const result = shouldDream({ lastDreamAt: 0, sessionsSinceDream: 5 }, { now: NOW });
    expect(result).toBe(true);
  });

  test("respects custom thresholds", () => {
    const result = shouldDream(
      { lastDreamAt: NOW - 1000, sessionsSinceDream: 1 },
      { now: NOW, minTimeSinceLastDreamMs: 500, minSessionsSinceLastDream: 1 },
    );
    expect(result).toBe(true);
  });

  test("uses defaults when options omitted", () => {
    // Default: 24h and 5 sessions
    const result = shouldDream({
      lastDreamAt: 0,
      sessionsSinceDream: DREAM_DEFAULTS.minSessionsSinceLastDream,
    });
    expect(result).toBe(true);
  });

  test("exact boundary — time gate passes at exact threshold", () => {
    const result = shouldDream({ lastDreamAt: NOW - DAY_MS, sessionsSinceDream: 5 }, { now: NOW });
    expect(result).toBe(true);
  });

  test("exact boundary — session gate passes at exact threshold", () => {
    const result = shouldDream(
      { lastDreamAt: NOW - DAY_MS * 2, sessionsSinceDream: 5 },
      { now: NOW },
    );
    expect(result).toBe(true);
  });
});

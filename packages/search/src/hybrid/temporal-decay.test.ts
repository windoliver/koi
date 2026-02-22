import { describe, expect, test } from "bun:test";
import type { SearchResult } from "../types.js";
import { applyTemporalDecay } from "./temporal-decay.js";

function makeResult(id: string, score: number, indexedAt?: number | string): SearchResult {
  return {
    id,
    score,
    content: `content-${id}`,
    metadata: indexedAt !== undefined ? { indexedAt } : {},
    source: "test",
  };
}

const NOW = Date.parse("2025-06-01T00:00:00Z");

describe("applyTemporalDecay", () => {
  test("no timestamp = no decay (evergreen)", () => {
    const results = [makeResult("a", 0.9)];
    const decayed = applyTemporalDecay(results, { now: NOW });
    expect(decayed[0]?.score).toBe(0.9);
  });

  test("document from today has minimal decay", () => {
    const results = [makeResult("a", 1.0, NOW)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, now: NOW });
    expect(decayed[0]?.score).toBeCloseTo(1.0, 5);
  });

  test("document from 30 days ago has ~50% score with 30-day half-life", () => {
    const thirtyDaysAgo = NOW - 30 * 86_400_000;
    const results = [makeResult("a", 1.0, thirtyDaysAgo)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, now: NOW });
    expect(decayed[0]?.score).toBeCloseTo(0.5, 2);
  });

  test("document from 60 days ago has ~25% score with 30-day half-life", () => {
    const sixtyDaysAgo = NOW - 60 * 86_400_000;
    const results = [makeResult("a", 1.0, sixtyDaysAgo)];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, now: NOW });
    expect(decayed[0]?.score).toBeCloseTo(0.25, 2);
  });

  test("recent document outranks older high-scoring document after decay", () => {
    const results = [
      makeResult("old", 0.9, NOW - 90 * 86_400_000), // 90 days old
      makeResult("new", 0.6, NOW - 1 * 86_400_000), // 1 day old
    ];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, now: NOW });
    // Old: 0.9 * e^(-ln2/30 * 90) = 0.9 * 0.125 ≈ 0.1125
    // New: 0.6 * e^(-ln2/30 * 1) ≈ 0.6 * 0.977 ≈ 0.586
    expect(decayed[1]?.score).toBeGreaterThan(decayed[0]?.score ?? 0);
  });

  test("handles ISO string timestamps", () => {
    const results = [makeResult("a", 1.0, "2025-05-02T00:00:00Z")];
    const decayed = applyTemporalDecay(results, { halfLifeDays: 30, now: NOW });
    // 30 days old → ~50%
    expect(decayed[0]?.score).toBeCloseTo(0.5, 2);
  });

  test("custom timestamp field", () => {
    const result: SearchResult = {
      id: "a",
      score: 1.0,
      content: "test",
      metadata: { createdAt: NOW - 30 * 86_400_000 },
      source: "test",
    };
    const decayed = applyTemporalDecay([result], {
      halfLifeDays: 30,
      timestampField: "createdAt",
      now: NOW,
    });
    expect(decayed[0]?.score).toBeCloseTo(0.5, 2);
  });

  test("explicit evergreen flag skips decay even with timestamp", () => {
    const thirtyDaysAgo = NOW - 30 * 86_400_000;
    const result: SearchResult = {
      id: "pinned",
      score: 0.8,
      content: "evergreen doc",
      metadata: { indexedAt: thirtyDaysAgo, evergreen: true },
      source: "test",
    };
    const decayed = applyTemporalDecay([result], { halfLifeDays: 30, now: NOW });
    expect(decayed[0]?.score).toBe(0.8); // Score unchanged
  });

  test("invalid timestamp is treated as evergreen", () => {
    const results = [makeResult("a", 0.9, "not-a-date")];
    const decayed = applyTemporalDecay(results, { now: NOW });
    expect(decayed[0]?.score).toBe(0.9);
  });

  test("preserves result ordering (just adjusts scores)", () => {
    const results = [makeResult("a", 0.9, NOW), makeResult("b", 0.5, NOW)];
    const decayed = applyTemporalDecay(results, { now: NOW });
    expect(decayed).toHaveLength(2);
    expect(decayed[0]?.id).toBe("a");
    expect(decayed[1]?.id).toBe("b");
  });
});

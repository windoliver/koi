import { describe, expect, test } from "bun:test";
import { computeSuggestedName, detectPatterns, filterSubsumed } from "./detect-patterns.js";
import { createTrace } from "./test-helpers.js";
import type { CrystallizationCandidate } from "./types.js";

function makeCandidate(toolIds: readonly string[], occurrences: number): CrystallizationCandidate {
  const key = toolIds.join("|");
  return {
    ngram: { steps: toolIds.map((id) => ({ toolId: id })), key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt: 0,
    suggestedName: toolIds.join("-then-"),
    outcomeStats: { successes: 0, withOutcome: 0 },
  };
}

describe("computeSuggestedName", () => {
  test("joins tool IDs with -then- and replaces underscores", () => {
    expect(
      computeSuggestedName({
        steps: [{ toolId: "read_file" }, { toolId: "parse_json" }],
        key: "read_file|parse_json",
      }),
    ).toBe("read-file-then-parse-json");
  });

  test("truncates names longer than 60 chars", () => {
    const name = computeSuggestedName({
      steps: [
        { toolId: "very_long_tool_name_one" },
        { toolId: "very_long_tool_name_two" },
        { toolId: "very_long_tool_name_three" },
      ],
      key: "x",
    });
    expect(name.length).toBeLessThanOrEqual(60);
    expect(name.endsWith("...")).toBe(true);
  });
});

describe("filterSubsumed", () => {
  test("drops a shorter candidate when a longer one with ≥ frequency contains it", () => {
    const shorter = makeCandidate(["a", "b"], 3);
    const longer = makeCandidate(["a", "b", "c"], 3);
    const kept = filterSubsumed([shorter, longer]);
    expect(kept.map((c) => c.ngram.key)).toEqual(["a|b|c"]);
  });

  test("keeps the shorter candidate when it has strictly higher frequency", () => {
    const shorter = makeCandidate(["a", "b"], 5);
    const longer = makeCandidate(["a", "b", "c"], 3);
    const kept = filterSubsumed([shorter, longer]);
    expect(kept.map((c) => c.ngram.key).sort()).toEqual(["a|b", "a|b|c"]);
  });

  test("keeps disjoint candidates", () => {
    const a = makeCandidate(["x", "y"], 3);
    const b = makeCandidate(["p", "q"], 3);
    expect(filterSubsumed([a, b])).toHaveLength(2);
  });

  test("does not subsume across pipe-key boundaries (regression: substring vs subsequence)", () => {
    // Pipe-joined keys: "b|c" vs "a|b|cd". Naive substring match would falsely
    // claim "b|c" is contained in "a|b|cd"; tokenised subsequence comparison
    // must reject it because [b, c] is not a contiguous subsequence of
    // [a, b, cd].
    const shorter = makeCandidate(["b", "c"], 3);
    const longer = makeCandidate(["a", "b", "cd"], 3);
    const kept = filterSubsumed([shorter, longer]);
    expect(kept.map((c) => c.ngram.key).sort()).toEqual(["a|b|cd", "b|c"]);
  });

  test("does not subsume when needle is a non-contiguous subsequence of haystack", () => {
    // [a, c] is a non-contiguous subsequence of [a, b, c]; subsumption must
    // require contiguity.
    const shorter = makeCandidate(["a", "c"], 3);
    const longer = makeCandidate(["a", "b", "c"], 3);
    const kept = filterSubsumed([shorter, longer]);
    expect(kept.map((c) => c.ngram.key).sort()).toEqual(["a|b|c", "a|c"]);
  });
});

describe("detectPatterns", () => {
  const clock = (): number => 0;

  test("detects a 3-step sequence repeated across turns", () => {
    const traces = [
      createTrace(0, ["read", "parse", "save"]),
      createTrace(1, ["read", "parse", "save"]),
      createTrace(2, ["read", "parse", "save"]),
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 3, maxNgramSize: 3 }, clock);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ngram.key).toBe("read|parse|save");
    expect(candidates[0]?.occurrences).toBe(3);
  });

  test("does not flag a single-occurrence sequence", () => {
    const traces = [createTrace(0, ["once", "only", "here"])];
    const candidates = detectPatterns(traces, {}, clock);
    expect(candidates).toHaveLength(0);
  });

  test("tracks frequency correctly across many turns", () => {
    const traces = [
      createTrace(0, ["a", "b"]),
      createTrace(1, ["a", "b"]),
      createTrace(2, ["a", "b"]),
      createTrace(3, ["a", "b"]),
      createTrace(4, ["x", "y"]), // noise
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 2 }, clock);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ngram.key).toBe("a|b");
    expect(candidates[0]?.occurrences).toBe(4);
    expect(candidates[0]?.turnIndices).toEqual([0, 1, 2, 3]);
  });

  test("merges duplicates via subsumption when longer pattern dominates", () => {
    // Same 3-step pattern across 3 turns — sub-2-grams are subsumed.
    const traces = [
      createTrace(0, ["a", "b", "c"]),
      createTrace(1, ["a", "b", "c"]),
      createTrace(2, ["a", "b", "c"]),
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 3 }, clock);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ngram.key).toBe("a|b|c");
  });

  test("scores candidates by frequency × complexity (longer + more frequent ranks higher)", () => {
    const traces = [
      // 4-step pattern: 3 occurrences
      createTrace(0, ["w", "x", "y", "z"]),
      createTrace(1, ["w", "x", "y", "z"]),
      createTrace(2, ["w", "x", "y", "z"]),
      // 2-step pattern: 3 occurrences (different tool IDs to avoid subsumption)
      createTrace(3, ["p", "q"]),
      createTrace(4, ["p", "q"]),
      createTrace(5, ["p", "q"]),
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 4 }, clock);
    const big = candidates.find((c) => c.ngram.key === "w|x|y|z");
    const small = candidates.find((c) => c.ngram.key === "p|q");
    expect(big).toBeDefined();
    expect(small).toBeDefined();
    expect(big?.score ?? 0).toBeGreaterThan(small?.score ?? 0);
  });

  test("respects minOccurrences threshold", () => {
    const traces = [createTrace(0, ["a", "b"]), createTrace(1, ["a", "b"])];
    const candidates = detectPatterns(
      traces,
      { minNgramSize: 2, maxNgramSize: 2, minOccurrences: 3 },
      clock,
    );
    expect(candidates).toHaveLength(0);
  });

  test("truncates results to maxCandidates", () => {
    const traces: ReturnType<typeof createTrace>[] = [];
    // Build 5 distinct 2-step patterns each with 3 occurrences.
    const patterns = [
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
      ["g", "h"],
      ["i", "j"],
    ];
    let turn = 0;
    for (const pat of patterns) {
      for (let i = 0; i < 3; i++) traces.push(createTrace(turn++, pat));
    }
    const candidates = detectPatterns(
      traces,
      { minNgramSize: 2, maxNgramSize: 2, maxCandidates: 2 },
      clock,
    );
    expect(candidates).toHaveLength(2);
  });

  test("ranks fresher pattern above stale higher-frequency pattern (score-driven sort)", () => {
    // 5 fresh occurrences at turns 0..4 vs 6 ancient occurrences at turns
    // 5..10. The stale pattern has more raw occurrences but recency decay
    // should drop its score below the fresh pattern's once enough time has
    // passed.
    const traces = [
      createTrace(0, ["fresh1", "fresh2"]),
      createTrace(1, ["fresh1", "fresh2"]),
      createTrace(2, ["fresh1", "fresh2"]),
      createTrace(3, ["fresh1", "fresh2"]),
      createTrace(4, ["fresh1", "fresh2"]),
      createTrace(5, ["stale1", "stale2"]),
      createTrace(6, ["stale1", "stale2"]),
      createTrace(7, ["stale1", "stale2"]),
      createTrace(8, ["stale1", "stale2"]),
      createTrace(9, ["stale1", "stale2"]),
      createTrace(10, ["stale1", "stale2"]),
    ];
    const stalePastTime = -10 * 1_800_000;
    const firstSeenTimes = new Map<string, number>([["stale1|stale2", stalePastTime]]);
    const candidates = detectPatterns(
      traces,
      { minNgramSize: 2, maxNgramSize: 2, firstSeenTimes },
      () => 0,
    );
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.ngram.key).toBe("fresh1|fresh2");
    expect(candidates[1]?.ngram.key).toBe("stale1|stale2");
  });

  test("ranks healthier pattern above failure-prone pattern (score-driven sort)", () => {
    // Two patterns with equal frequency but different aggregate success
    // rates. Score-driven ordering must put the healthy one first.
    const ok = [{}, {}] as const;
    const bad = [undefined, undefined] as const;
    const traces = [
      createTrace(0, ["good1", "good2"], ok),
      createTrace(1, ["good1", "good2"], ok),
      createTrace(2, ["good1", "good2"], ok),
      createTrace(3, ["bad1", "bad2"], bad),
      createTrace(4, ["bad1", "bad2"], bad),
      createTrace(5, ["bad1", "bad2"], bad),
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 2 }, clock);
    expect(candidates).toHaveLength(2);
    expect(candidates[0]?.ngram.key).toBe("good1|good2");
    expect(candidates[1]?.ngram.key).toBe("bad1|bad2");
  });

  test("aggregates outcome stats across every occurrence (not just one representative)", () => {
    // Same pattern across 4 turns: 3 succeed, 1 fails. Aggregate outcome
    // stats must reflect the full set, not the single n-gram representative.
    const traces = [
      createTrace(0, ["a", "b"], [{}, {}]),
      createTrace(1, ["a", "b"], [{}, {}]),
      createTrace(2, ["a", "b"], [{}, {}]),
      createTrace(3, ["a", "b"], [undefined, undefined]),
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 2 }, clock);
    expect(candidates).toHaveLength(1);
    const stats = candidates[0]?.outcomeStats;
    // 3 turns × 2 successes + 1 turn × 2 failures = 6 successes, 8 with outcome
    expect(stats).toEqual({ successes: 6, withOutcome: 8 });
  });

  test("uses firstSeenTimes for detectedAt when key was previously observed", () => {
    const traces = [
      createTrace(0, ["a", "b"]),
      createTrace(1, ["a", "b"]),
      createTrace(2, ["a", "b"]),
    ];
    const firstSeenTimes = new Map<string, number>([["a|b", 1234]]);
    const candidates = detectPatterns(
      traces,
      { minNgramSize: 2, maxNgramSize: 2, firstSeenTimes },
      () => 9999,
    );
    expect(candidates[0]?.detectedAt).toBe(1234);
  });
});

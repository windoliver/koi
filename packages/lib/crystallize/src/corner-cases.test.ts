/**
 * Corner-case + invariant coverage for the public detection surface.
 * Complements the per-module unit tests with cases the unit suites omit:
 * separator-collision, degenerate config, malformed traces, and structural
 * invariants of the candidate pipeline.
 */

import { describe, expect, test } from "bun:test";
import type { ToolCallId, TraceEvent, TurnTrace } from "@koi/core";
import { sessionId } from "@koi/core";
import { computeCrystallizeScore } from "./compute-score.js";
import { detectPatterns, filterSubsumed } from "./detect-patterns.js";
import { computeNgramKey, extractNgrams, extractToolSequences } from "./ngram.js";
import { createTrace } from "./test-helpers.js";
import type { CrystallizationCandidate } from "./types.js";

const clock = (): number => 0;

function makeCandidate(toolIds: readonly string[], occurrences: number): CrystallizationCandidate {
  const key = computeNgramKey(toolIds.map((id) => ({ toolId: id })));
  return {
    ngram: { steps: toolIds.map((id) => ({ toolId: id })), key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt: 0,
    suggestedName: toolIds.join("-then-"),
    outcomeStats: { successes: 0, withOutcome: 0 },
  };
}

describe("computeNgramKey — separator safety", () => {
  test("tool IDs containing `|` do not collide across distinct sequences", () => {
    const left = computeNgramKey([{ toolId: "a|b" }, { toolId: "c" }]);
    const right = computeNgramKey([{ toolId: "a" }, { toolId: "b|c" }]);
    expect(left).not.toBe(right);
  });

  test("escapes backslashes so that escape sequences themselves stay unambiguous", () => {
    const a = computeNgramKey([{ toolId: "x\\" }, { toolId: "y" }]);
    const b = computeNgramKey([{ toolId: "x" }, { toolId: "\\y" }]);
    expect(a).not.toBe(b);
  });

  test("does not regress simple tool IDs without special characters", () => {
    expect(computeNgramKey([{ toolId: "read" }, { toolId: "parse" }])).toBe("read|parse");
  });
});

describe("extractToolSequences — non-tool_call events", () => {
  test("trace with only model_call / streaming events yields an empty step list", () => {
    const events: readonly TraceEvent[] = [
      {
        eventIndex: 0,
        turnIndex: 0,
        timestamp: 1,
        event: { kind: "model_call", request: {}, response: {}, durationMs: 5 },
      },
      {
        eventIndex: 1,
        turnIndex: 0,
        timestamp: 2,
        event: { kind: "model_stream_start", request: {} },
      },
      {
        eventIndex: 2,
        turnIndex: 0,
        timestamp: 3,
        event: { kind: "model_stream_end", response: {}, durationMs: 5 },
      },
    ];
    const trace: TurnTrace = {
      turnIndex: 0,
      sessionId: sessionId("s"),
      agentId: "a",
      events,
      durationMs: 5,
    };
    const seqs = extractToolSequences([trace]);
    expect(seqs[0]?.steps).toHaveLength(0);
  });

  test("interleaved model + tool events keep tool order and skip non-tool events", () => {
    const events: readonly TraceEvent[] = [
      {
        eventIndex: 0,
        turnIndex: 0,
        timestamp: 1,
        event: { kind: "model_call", request: {}, response: {}, durationMs: 1 },
      },
      {
        eventIndex: 1,
        turnIndex: 0,
        timestamp: 2,
        event: {
          kind: "tool_call",
          toolId: "first",
          callId: "c1" as ToolCallId,
          input: {},
          output: {},
          durationMs: 1,
        },
      },
      {
        eventIndex: 2,
        turnIndex: 0,
        timestamp: 3,
        event: { kind: "model_stream_start", request: {} },
      },
      {
        eventIndex: 3,
        turnIndex: 0,
        timestamp: 4,
        event: {
          kind: "tool_call",
          toolId: "second",
          callId: "c2" as ToolCallId,
          input: {},
          output: {},
          durationMs: 1,
        },
      },
    ];
    const trace: TurnTrace = {
      turnIndex: 0,
      sessionId: sessionId("s"),
      agentId: "a",
      events,
      durationMs: 5,
    };
    const seqs = extractToolSequences([trace]);
    expect(seqs[0]?.steps.map((s) => s.toolId)).toEqual(["first", "second"]);
  });
});

describe("detectPatterns — degenerate inputs", () => {
  test("empty traces array returns no candidates", () => {
    expect(detectPatterns([], {}, clock)).toEqual([]);
  });

  test("minSize > maxSize emits no candidates (empty inner range)", () => {
    const traces = [
      createTrace(0, ["a", "b"]),
      createTrace(1, ["a", "b"]),
      createTrace(2, ["a", "b"]),
    ];
    expect(detectPatterns(traces, { minNgramSize: 5, maxNgramSize: 2 }, clock)).toEqual([]);
  });

  test("minNgramSize: 1 surfaces single-tool repetition as a candidate", () => {
    const traces = [createTrace(0, ["solo"]), createTrace(1, ["solo"]), createTrace(2, ["solo"])];
    const candidates = detectPatterns(traces, { minNgramSize: 1, maxNgramSize: 1 }, clock);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.ngram.key).toBe("solo");
    expect(candidates[0]?.occurrences).toBe(3);
  });

  test("case-sensitive tool IDs are kept as distinct keys", () => {
    const traces = [
      createTrace(0, ["Read", "Write"]),
      createTrace(1, ["read", "write"]),
      createTrace(2, ["Read", "Write"]),
      createTrace(3, ["read", "write"]),
      createTrace(4, ["Read", "Write"]),
      createTrace(5, ["read", "write"]),
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 2 }, clock);
    const keys = new Set(candidates.map((c) => c.ngram.key));
    expect(keys.has("Read|Write")).toBe(true);
    expect(keys.has("read|write")).toBe(true);
  });

  test("tool IDs containing the pipe character produce distinct n-grams", () => {
    // Two sequences that would collide under naive `|`-join keying:
    //   ["a|b", "c"]  vs.  ["a", "b|c"]
    // Repeated 3+ times each, both must surface as separate candidates.
    const traces = [
      createTrace(0, ["a|b", "c"]),
      createTrace(1, ["a|b", "c"]),
      createTrace(2, ["a|b", "c"]),
      createTrace(3, ["a", "b|c"]),
      createTrace(4, ["a", "b|c"]),
      createTrace(5, ["a", "b|c"]),
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 2 }, clock);
    expect(candidates).toHaveLength(2);
    const keys = new Set(candidates.map((c) => c.ngram.key));
    expect(keys.size).toBe(2);
  });

  test("self-overlapping pattern (`a,a,a,a`) within a turn dedupes to one occurrence", () => {
    const traces = [
      createTrace(0, ["a", "a", "a", "a"]),
      createTrace(1, ["a", "a", "a", "a"]),
      createTrace(2, ["a", "a", "a", "a"]),
    ];
    const map = extractNgrams(extractToolSequences(traces), 2, 2);
    expect(map.get("a|a")?.turnIndices).toEqual([0, 1, 2]);
  });
});

describe("filterSubsumed — overlap semantics", () => {
  test("equal-length overlapping n-grams are both kept (subsumption requires strict length>)", () => {
    const abc = makeCandidate(["a", "b", "c"], 3);
    const bcd = makeCandidate(["b", "c", "d"], 3);
    const kept = filterSubsumed([abc, bcd]);
    expect(kept).toHaveLength(2);
  });

  test("is idempotent — filtering twice yields the same set", () => {
    const a = makeCandidate(["a", "b"], 5);
    const b = makeCandidate(["a", "b", "c"], 3);
    const c = makeCandidate(["x", "y"], 4);
    const once = filterSubsumed([a, b, c]);
    const twice = filterSubsumed(once);
    expect(twice.map((x) => x.ngram.key).sort()).toEqual(once.map((x) => x.ngram.key).sort());
  });
});

describe("computeCrystallizeScore — numeric guards", () => {
  test("non-positive recencyHalfLifeMs falls back to the default (no NaN)", () => {
    const c = makeCandidate(["a", "b"], 3);
    const zero = computeCrystallizeScore(c, 0, { recencyHalfLifeMs: 0 });
    const negative = computeCrystallizeScore(c, 0, { recencyHalfLifeMs: -100 });
    expect(Number.isFinite(zero)).toBe(true);
    expect(Number.isFinite(negative)).toBe(true);
    expect(zero).toBeGreaterThan(0);
    expect(negative).toBeGreaterThan(0);
  });

  test("returned candidates always have a finite score", () => {
    const traces = [
      createTrace(0, ["a", "b"]),
      createTrace(1, ["a", "b"]),
      createTrace(2, ["a", "b"]),
    ];
    const candidates = detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 2 }, clock);
    for (const c of candidates) {
      expect(Number.isFinite(c.score ?? 0)).toBe(true);
    }
  });
});

describe("detectPatterns — pipeline invariants", () => {
  function buildBusyTraces(turnCount: number): readonly TurnTrace[] {
    const tools = ["read", "parse", "validate", "save", "log"];
    const traces: TurnTrace[] = [];
    for (let t = 0; t < turnCount; t++) {
      const len = 3 + (t % 3);
      const ids = Array.from({ length: len }, (_, i) => tools[(t + i) % tools.length] ?? "noop");
      traces.push(createTrace(t, ids));
    }
    return traces;
  }

  test("every returned candidate meets minOccurrences", () => {
    const candidates = detectPatterns(
      buildBusyTraces(40),
      { minNgramSize: 2, maxNgramSize: 4, minOccurrences: 4 },
      clock,
    );
    for (const c of candidates) {
      expect(c.occurrences).toBeGreaterThanOrEqual(4);
    }
  });

  test("returned candidates are sorted by score descending (non-increasing)", () => {
    const candidates = detectPatterns(
      buildBusyTraces(40),
      { minNgramSize: 2, maxNgramSize: 4 },
      clock,
    );
    for (let i = 1; i < candidates.length; i++) {
      const prev = candidates[i - 1]?.score ?? 0;
      const cur = candidates[i]?.score ?? 0;
      expect(cur).toBeLessThanOrEqual(prev);
    }
  });

  test("result length never exceeds maxCandidates", () => {
    const candidates = detectPatterns(
      buildBusyTraces(60),
      { minNgramSize: 2, maxNgramSize: 4, maxCandidates: 3 },
      clock,
    );
    expect(candidates.length).toBeLessThanOrEqual(3);
  });

  test("firstSeenTimes entries for keys absent from the current map are silently ignored", () => {
    const traces = [
      createTrace(0, ["a", "b"]),
      createTrace(1, ["a", "b"]),
      createTrace(2, ["a", "b"]),
    ];
    const stale = new Map<string, number>([
      ["nonexistent|key", -1_000_000_000],
      ["another|ghost", -2_000_000_000],
    ]);
    expect(() =>
      detectPatterns(traces, { minNgramSize: 2, maxNgramSize: 2, firstSeenTimes: stale }, () => 0),
    ).not.toThrow();
  });
});

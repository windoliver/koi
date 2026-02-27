import { describe, expect, test } from "bun:test";
import type { TurnTrace } from "@koi/core";
import { sessionId } from "@koi/core";
import { computeNgramKey, extractNgrams, extractToolSequences } from "./ngram.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTrace(turnIndex: number, toolIds: readonly string[]): TurnTrace {
  return {
    turnIndex,
    sessionId: sessionId("test-session"),
    agentId: "test-agent",
    events: toolIds.map((toolId, i) => ({
      eventIndex: i,
      turnIndex,
      event: {
        kind: "tool_call" as const,
        toolId,
        callId: `call-${i}` as import("@koi/core").ToolCallId,
        input: {},
        output: {},
        durationMs: 10,
      },
      timestamp: 1000 + i,
    })),
    durationMs: toolIds.length * 10,
  };
}

// ---------------------------------------------------------------------------
// extractToolSequences
// ---------------------------------------------------------------------------

describe("extractToolSequences", () => {
  test("extracts tool IDs in order", () => {
    const traces = [createTrace(0, ["fetch", "parse", "save"])];
    const result = extractToolSequences(traces);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([{ toolId: "fetch" }, { toolId: "parse" }, { toolId: "save" }]);
  });

  test("filters non-tool events", () => {
    const trace: TurnTrace = {
      turnIndex: 0,
      sessionId: sessionId("test"),
      agentId: "agent",
      events: [
        {
          eventIndex: 0,
          turnIndex: 0,
          event: { kind: "model_call", request: {}, response: {}, durationMs: 5 },
          timestamp: 1000,
        },
        {
          eventIndex: 1,
          turnIndex: 0,
          event: {
            kind: "tool_call",
            toolId: "fetch",
            callId: "c1" as import("@koi/core").ToolCallId,
            input: {},
            output: {},
            durationMs: 10,
          },
          timestamp: 1001,
        },
      ],
      durationMs: 15,
    };
    const result = extractToolSequences([trace]);
    expect(result[0]).toEqual([{ toolId: "fetch" }]);
  });

  test("returns empty arrays for turns with no tool calls", () => {
    const trace: TurnTrace = {
      turnIndex: 0,
      sessionId: sessionId("test"),
      agentId: "agent",
      events: [],
      durationMs: 0,
    };
    const result = extractToolSequences([trace]);
    expect(result[0]).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// computeNgramKey
// ---------------------------------------------------------------------------

describe("computeNgramKey", () => {
  test("joins tool IDs with pipe separator", () => {
    const key = computeNgramKey([{ toolId: "fetch" }, { toolId: "parse" }]);
    expect(key).toBe("fetch|parse");
  });

  test("single step key", () => {
    expect(computeNgramKey([{ toolId: "read" }])).toBe("read");
  });
});

// ---------------------------------------------------------------------------
// extractNgrams
// ---------------------------------------------------------------------------

describe("extractNgrams", () => {
  test("extracts 2-grams from sequences", () => {
    const sequences = [[{ toolId: "fetch" }, { toolId: "parse" }, { toolId: "save" }]];
    const result = extractNgrams(sequences, 2, 2);
    expect(result.size).toBe(2);
    expect(result.has("fetch|parse")).toBe(true);
    expect(result.has("parse|save")).toBe(true);
  });

  test("tracks turn indices across multiple turns", () => {
    const sequences = [
      [{ toolId: "fetch" }, { toolId: "parse" }],
      [{ toolId: "fetch" }, { toolId: "parse" }],
      [{ toolId: "other" }],
    ];
    const result = extractNgrams(sequences, 2, 2);
    const entry = result.get("fetch|parse");
    expect(entry).toBeDefined();
    expect(entry?.turnIndices).toEqual([0, 1]);
  });

  test("respects min and max size", () => {
    const sequences = [[{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }]];
    const result = extractNgrams(sequences, 2, 3);
    // 2-grams: a|b, b|c
    // 3-grams: a|b|c
    expect(result.size).toBe(3);
    expect(result.has("a|b|c")).toBe(true);
  });

  test("skips sequences shorter than minSize", () => {
    const sequences = [[{ toolId: "a" }]];
    const result = extractNgrams(sequences, 2, 3);
    expect(result.size).toBe(0);
  });

  test("does not duplicate turn index for same turn", () => {
    // Same n-gram appears twice in same turn (a|b at positions 0,1 and 2,3)
    const sequences = [[{ toolId: "a" }, { toolId: "b" }, { toolId: "a" }, { toolId: "b" }]];
    const result = extractNgrams(sequences, 2, 2);
    const entry = result.get("a|b");
    expect(entry).toBeDefined();
    // Should only have turn index 0 once (deduped per turn)
    expect(entry?.turnIndices).toEqual([0]);
  });
});

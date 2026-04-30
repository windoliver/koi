import { describe, expect, test } from "bun:test";
import { sessionId } from "@koi/core";
import type { TurnSequence } from "./ngram.js";
import { computeNgramKey, extractNgrams, extractToolSequences } from "./ngram.js";
import { createTrace } from "./test-helpers.js";

const SESSION = sessionId("test-session");
const AGENT = "test-agent";

function turn(turnIndex: number, ids: readonly string[]): TurnSequence {
  return {
    location: { sessionId: SESSION, agentId: AGENT, turnIndex },
    steps: ids.map((toolId) => ({ toolId })),
  };
}

describe("computeNgramKey", () => {
  test("pipe-joins tool IDs", () => {
    expect(computeNgramKey([{ toolId: "a" }, { toolId: "b" }, { toolId: "c" }])).toBe("a|b|c");
  });
});

describe("extractToolSequences", () => {
  test("projects tool_call events in order, preserving real turnIndex + identity", () => {
    const seqs = extractToolSequences([createTrace(7, ["read", "parse", "save"])]);
    expect(seqs).toHaveLength(1);
    expect(seqs[0]?.location.turnIndex).toBe(7);
    expect(seqs[0]?.steps.map((s) => s.toolId)).toEqual(["read", "parse", "save"]);
  });

  test("yields no outcome signal when output is undefined (no capture)", () => {
    const seqs = extractToolSequences([createTrace(0, ["broken"], [undefined])]);
    expect(seqs[0]?.steps[0]?.outcome).toBeUndefined();
  });

  test("plain object with non-envelope `error` field still scores as success", () => {
    const seqs = extractToolSequences([createTrace(0, ["broken"], [{ error: "boom" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("success");
  });

  test("classifies kind:error envelopes as failure", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [{ kind: "error", message: "x" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("classifies kind:denied envelopes as failure", () => {
    const seqs = extractToolSequences([createTrace(0, ["x"], [{ kind: "denied" }])]);
    expect(seqs[0]?.steps[0]?.outcome).toBe("failure");
  });

  test("treats null output as no outcome (not failure)", () => {
    const seqs = extractToolSequences([createTrace(0, ["void_tool"], [null])]);
    expect(seqs[0]?.steps[0]?.outcome).toBeUndefined();
  });

  test("validation reject with kind:validation is neutral (no outcome signal)", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["v"], [{ kind: "validation", error: "bad input" }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBeUndefined();
  });

  test("validation reject with code:VALIDATION (no kind) is neutral (no outcome signal)", () => {
    const seqs = extractToolSequences([
      createTrace(0, ["v"], [{ error: "bad input", code: "VALIDATION" }]),
    ]);
    expect(seqs[0]?.steps[0]?.outcome).toBeUndefined();
  });
});

describe("extractNgrams", () => {
  test("emits sliding-window n-grams of size [min..max]", () => {
    const map = extractNgrams([turn(0, ["a", "b", "c"])], 2, 3);
    expect(map.get("a|b")).toBeDefined();
    expect(map.get("b|c")).toBeDefined();
    expect(map.get("a|b|c")).toBeDefined();
    expect(map.get("a|b|c|d")).toBeUndefined();
  });

  test("counts a turn once per key even when pattern repeats within turn", () => {
    const map = extractNgrams([turn(0, ["a", "b", "a", "b"])], 2, 2);
    expect(map.get("a|b")?.locations.map((l) => l.turnIndex)).toEqual([0]);
  });

  test("aggregates same n-gram across multiple turns", () => {
    const map = extractNgrams(
      [turn(0, ["a", "b"]), turn(1, ["a", "b"]), turn(2, ["a", "b"])],
      2,
      2,
    );
    expect(map.get("a|b")?.locations.map((l) => l.turnIndex)).toEqual([0, 1, 2]);
  });

  test("preserves real (non-zero, non-contiguous) turn indices from the source traces", () => {
    const map = extractNgrams(
      [turn(10, ["a", "b"]), turn(42, ["a", "b"]), turn(100, ["a", "b"])],
      2,
      2,
    );
    expect(map.get("a|b")?.locations.map((l) => l.turnIndex)).toEqual([10, 42, 100]);
  });

  test("does not collapse occurrences from different sessions even when turn indices collide", () => {
    const sA = sessionId("sess-A");
    const sB = sessionId("sess-B");
    const make = (sid: typeof sA): TurnSequence => ({
      location: { sessionId: sid, agentId: AGENT, turnIndex: 0 },
      steps: [{ toolId: "a" }, { toolId: "b" }],
    });
    const map = extractNgrams([make(sA), make(sB)], 2, 2);
    const locs = map.get("a|b")?.locations ?? [];
    expect(locs).toHaveLength(2);
    expect(new Set(locs.map((l) => l.sessionId)).size).toBe(2);
  });

  test("does not collapse occurrences from different agents even when (session, turn) collide", () => {
    const sid = sessionId("shared-sess");
    const make = (agentId: string): TurnSequence => ({
      location: { sessionId: sid, agentId, turnIndex: 0 },
      steps: [{ toolId: "a" }, { toolId: "b" }],
    });
    const map = extractNgrams([make("agent-A"), make("agent-B")], 2, 2);
    expect(map.get("a|b")?.locations).toHaveLength(2);
  });

  test("empty sequence contributes no n-grams", () => {
    const map = extractNgrams([turn(0, [])], 2, 3);
    expect(map.size).toBe(0);
  });
});

import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import { toolCallId } from "@koi/core";
import {
  assertCostUnder,
  assertNoToolErrors,
  assertTextContains,
  assertTextMatches,
  assertToolSequence,
  assertTurnCount,
} from "./assertions.js";

function mkDone(opts: { costUsd?: number } = {}): EngineEvent {
  return {
    kind: "done",
    output: {
      content: [],
      stopReason: "completed",
      metrics: {
        totalTokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        turns: 1,
        durationMs: 0,
        ...(opts.costUsd !== undefined ? { costUsd: opts.costUsd } : {}),
      },
    },
  };
}

function mkToolStart(name: string, id: string): EngineEvent {
  return { kind: "tool_call_start", toolName: name, callId: toolCallId(id) };
}

function mkToolEnd(id: string, result: unknown): EngineEvent {
  return { kind: "tool_call_end", callId: toolCallId(id), result };
}

describe("assertToolSequence — exact", () => {
  test("passes on exact match", () => {
    const events: EngineEvent[] = [mkToolStart("a", "1"), mkToolStart("b", "2")];
    assertToolSequence(events, ["a", "b"]);
  });

  test("throws on mismatch", () => {
    const events: EngineEvent[] = [mkToolStart("a", "1")];
    expect(() => assertToolSequence(events, ["b"])).toThrow(/expected \[b\]/);
  });
});

describe("assertToolSequence — startsWith", () => {
  test("passes when prefix matches", () => {
    const events: EngineEvent[] = [
      mkToolStart("a", "1"),
      mkToolStart("b", "2"),
      mkToolStart("c", "3"),
    ];
    assertToolSequence(events, ["a", "b"], { mode: "startsWith" });
  });

  test("throws when prefix too short", () => {
    const events: EngineEvent[] = [mkToolStart("a", "1")];
    expect(() => assertToolSequence(events, ["a", "b"], { mode: "startsWith" })).toThrow(
      /at least 2/,
    );
  });
});

describe("assertToolSequence — contains", () => {
  test("passes when subsequence found", () => {
    const events: EngineEvent[] = [
      mkToolStart("x", "1"),
      mkToolStart("a", "2"),
      mkToolStart("b", "3"),
      mkToolStart("y", "4"),
    ];
    assertToolSequence(events, ["a", "b"], { mode: "contains" });
  });

  test("throws when subsequence not found", () => {
    const events: EngineEvent[] = [
      mkToolStart("a", "1"),
      mkToolStart("x", "2"),
      mkToolStart("b", "3"),
    ];
    expect(() => assertToolSequence(events, ["a", "b"], { mode: "contains" })).toThrow(/not found/);
  });
});

describe("assertNoToolErrors", () => {
  test("passes when no tool_call_end events", () => {
    assertNoToolErrors([]);
  });

  test("passes on clean results", () => {
    const events: EngineEvent[] = [mkToolEnd("1", { items: [] })];
    assertNoToolErrors(events);
  });

  test("throws on { ok: false }", () => {
    const events: EngineEvent[] = [mkToolEnd("1", { ok: false, error: "oops" })];
    expect(() => assertNoToolErrors(events)).toThrow(/ok=false/);
  });

  test("throws on { kind: error }", () => {
    const events: EngineEvent[] = [mkToolEnd("1", { kind: "error", message: "boom" })];
    expect(() => assertNoToolErrors(events)).toThrow(/kind=error/);
  });

  test("throws on object with error field", () => {
    const events: EngineEvent[] = [mkToolEnd("1", { error: "boom" })];
    expect(() => assertNoToolErrors(events)).toThrow(/error field/);
  });
});

describe("assertCostUnder", () => {
  test("passes when cost is under limit", () => {
    assertCostUnder([mkDone({ costUsd: 0.01 })], 0.05);
  });

  test("passes when cost is undefined", () => {
    assertCostUnder([mkDone()], 0.05);
  });

  test("throws when cost equals limit", () => {
    expect(() => assertCostUnder([mkDone({ costUsd: 0.05 })], 0.05)).toThrow(/expected cost/);
  });

  test("throws when cost exceeds limit", () => {
    expect(() => assertCostUnder([mkDone({ costUsd: 0.1 })], 0.05)).toThrow(/\$0\.1/);
  });

  test("throws when no done event", () => {
    expect(() => assertCostUnder([], 0.05)).toThrow(/no done event/);
  });
});

describe("assertTextContains", () => {
  test("passes when substring present", () => {
    const events: EngineEvent[] = [{ kind: "text_delta", delta: "hello world" }];
    assertTextContains(events, "world");
  });

  test("throws when substring missing", () => {
    const events: EngineEvent[] = [{ kind: "text_delta", delta: "hello" }];
    expect(() => assertTextContains(events, "world")).toThrow(/to contain/);
  });
});

describe("assertTextMatches", () => {
  test("passes on regex match", () => {
    const events: EngineEvent[] = [{ kind: "text_delta", delta: "abc123" }];
    assertTextMatches(events, /\d+/);
  });

  test("throws on regex mismatch", () => {
    const events: EngineEvent[] = [{ kind: "text_delta", delta: "abc" }];
    expect(() => assertTextMatches(events, /\d+/)).toThrow(/to match/);
  });
});

describe("assertTurnCount", () => {
  test("passes on exact turn count", () => {
    const events: EngineEvent[] = [
      { kind: "turn_start", turnIndex: 0 },
      { kind: "turn_end", turnIndex: 0 },
      { kind: "turn_start", turnIndex: 1 },
      { kind: "turn_end", turnIndex: 1 },
    ];
    assertTurnCount(events, 2);
  });

  test("throws on mismatch", () => {
    expect(() => assertTurnCount([{ kind: "turn_start", turnIndex: 0 }], 2)).toThrow(/expected 2/);
  });
});

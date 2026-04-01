/**
 * Tests for matchesBreakpoint — pure predicate evaluator for breakpoint conditions.
 */

import { describe, expect, test } from "bun:test";
import type { BreakpointPredicate, EngineEvent, EngineOutput } from "@koi/core";
import { toolCallId } from "@koi/core";
import type { MatchContext } from "./breakpoint-matcher.js";
import { matchesBreakpoint } from "./breakpoint-matcher.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurnStart(turnIndex: number): EngineEvent {
  return { kind: "turn_start", turnIndex };
}

function makeTurnEnd(turnIndex: number): EngineEvent {
  return { kind: "turn_end", turnIndex };
}

function makeToolCallStart(toolName: string): EngineEvent {
  return { kind: "tool_call_start", toolName, callId: toolCallId("call-1") };
}

function makeDoneWithError(): EngineEvent {
  const output: EngineOutput = {
    content: [],
    stopReason: "error",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
  };
  return { kind: "done", output };
}

function makeDoneCompleted(): EngineEvent {
  const output: EngineOutput = {
    content: [],
    stopReason: "completed",
    metrics: { totalTokens: 0, inputTokens: 0, outputTokens: 0, turns: 0, durationMs: 0 },
  };
  return { kind: "done", output };
}

function makeTextDelta(): EngineEvent {
  return { kind: "text_delta", delta: "hello" };
}

function ctx(event: EngineEvent, turnIndex = 0): MatchContext {
  return { event, turnIndex };
}

// ---------------------------------------------------------------------------
// Tests: turn predicate
// ---------------------------------------------------------------------------

describe("matchesBreakpoint — turn", () => {
  const turnPredicate: BreakpointPredicate = { kind: "turn" };

  test("matches turn_start events", () => {
    expect(matchesBreakpoint(turnPredicate, ctx(makeTurnStart(0)))).toBe(true);
  });

  test("matches turn_end events", () => {
    expect(matchesBreakpoint(turnPredicate, ctx(makeTurnEnd(0)))).toBe(true);
  });

  test("does not match non-turn events", () => {
    expect(matchesBreakpoint(turnPredicate, ctx(makeTextDelta()))).toBe(false);
    expect(matchesBreakpoint(turnPredicate, ctx(makeToolCallStart("read")))).toBe(false);
    expect(matchesBreakpoint(turnPredicate, ctx(makeDoneCompleted()))).toBe(false);
  });

  test("with turnIndex matches only that specific turn", () => {
    const pred: BreakpointPredicate = { kind: "turn", turnIndex: 3 };
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(3), 3))).toBe(true);
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(0), 0))).toBe(false);
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(5), 5))).toBe(false);
  });

  test("with every matches periodic turns", () => {
    const pred: BreakpointPredicate = { kind: "turn", every: 3 };
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(0), 0))).toBe(true); // 0 % 3 === 0
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(1), 1))).toBe(false); // 1 % 3 !== 0
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(2), 2))).toBe(false); // 2 % 3 !== 0
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(3), 3))).toBe(true); // 3 % 3 === 0
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(6), 6))).toBe(true); // 6 % 3 === 0
  });

  test("with every does not match non-turn events even when turnIndex matches", () => {
    const pred: BreakpointPredicate = { kind: "turn", every: 2 };
    expect(matchesBreakpoint(pred, ctx(makeToolCallStart("read"), 0))).toBe(false);
  });

  test("with turnIndex does not match non-turn events", () => {
    const pred: BreakpointPredicate = { kind: "turn", turnIndex: 0 };
    expect(matchesBreakpoint(pred, ctx(makeDoneCompleted(), 0))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: tool_call predicate
// ---------------------------------------------------------------------------

describe("matchesBreakpoint — tool_call", () => {
  const toolCallPredicate: BreakpointPredicate = { kind: "tool_call" };

  test("matches tool_call_start events", () => {
    expect(matchesBreakpoint(toolCallPredicate, ctx(makeToolCallStart("bash")))).toBe(true);
  });

  test("does not match non-tool events", () => {
    expect(matchesBreakpoint(toolCallPredicate, ctx(makeTurnStart(0)))).toBe(false);
    expect(matchesBreakpoint(toolCallPredicate, ctx(makeTextDelta()))).toBe(false);
    expect(matchesBreakpoint(toolCallPredicate, ctx(makeDoneCompleted()))).toBe(false);
  });

  test("with toolName matches only that specific tool", () => {
    const pred: BreakpointPredicate = { kind: "tool_call", toolName: "bash" };
    expect(matchesBreakpoint(pred, ctx(makeToolCallStart("bash")))).toBe(true);
    expect(matchesBreakpoint(pred, ctx(makeToolCallStart("read")))).toBe(false);
    expect(matchesBreakpoint(pred, ctx(makeToolCallStart("write")))).toBe(false);
  });

  test("with toolName does not match non-tool events", () => {
    const pred: BreakpointPredicate = { kind: "tool_call", toolName: "bash" };
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(0)))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: error predicate
// ---------------------------------------------------------------------------

describe("matchesBreakpoint — error", () => {
  const errorPredicate: BreakpointPredicate = { kind: "error" };

  test("matches done events with error stopReason", () => {
    expect(matchesBreakpoint(errorPredicate, ctx(makeDoneWithError()))).toBe(true);
  });

  test("does not match done events with non-error stopReason", () => {
    expect(matchesBreakpoint(errorPredicate, ctx(makeDoneCompleted()))).toBe(false);
  });

  test("does not match non-done events", () => {
    expect(matchesBreakpoint(errorPredicate, ctx(makeTurnStart(0)))).toBe(false);
    expect(matchesBreakpoint(errorPredicate, ctx(makeToolCallStart("bash")))).toBe(false);
    expect(matchesBreakpoint(errorPredicate, ctx(makeTextDelta()))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: event_kind predicate
// ---------------------------------------------------------------------------

describe("matchesBreakpoint — event_kind", () => {
  test("matches when event kind equals the specified eventKind", () => {
    const pred: BreakpointPredicate = { kind: "event_kind", eventKind: "text_delta" };
    expect(matchesBreakpoint(pred, ctx(makeTextDelta()))).toBe(true);
  });

  test("matches turn_start by event_kind", () => {
    const pred: BreakpointPredicate = { kind: "event_kind", eventKind: "turn_start" };
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(0)))).toBe(true);
    expect(matchesBreakpoint(pred, ctx(makeTurnEnd(0)))).toBe(false);
  });

  test("matches done by event_kind", () => {
    const pred: BreakpointPredicate = { kind: "event_kind", eventKind: "done" };
    expect(matchesBreakpoint(pred, ctx(makeDoneCompleted()))).toBe(true);
    expect(matchesBreakpoint(pred, ctx(makeDoneWithError()))).toBe(true);
  });

  test("does not match when event kind differs", () => {
    const pred: BreakpointPredicate = { kind: "event_kind", eventKind: "tool_call_start" };
    expect(matchesBreakpoint(pred, ctx(makeTurnStart(0)))).toBe(false);
    expect(matchesBreakpoint(pred, ctx(makeTextDelta()))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: exhaustive check on unknown predicate kind
// ---------------------------------------------------------------------------

describe("matchesBreakpoint — exhaustive check", () => {
  test("throws on unknown predicate kind", () => {
    const unknownPredicate = { kind: "unknown_predicate" } as unknown as BreakpointPredicate;
    expect(() => matchesBreakpoint(unknownPredicate, ctx(makeTurnStart(0)))).toThrow(
      /Unhandled breakpoint kind/,
    );
  });
});

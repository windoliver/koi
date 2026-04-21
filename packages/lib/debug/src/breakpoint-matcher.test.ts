import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput } from "@koi/core";
import { toolCallId } from "@koi/core";
import { matchesBreakpoint } from "./breakpoint-matcher.js";

function turnStartEvent(turnIndex: number): EngineEvent {
  return { kind: "turn_start", turnIndex };
}

function turnEndEvent(turnIndex: number): EngineEvent {
  return { kind: "turn_end", turnIndex };
}

function toolCallStartEvent(toolName: string): EngineEvent {
  return { kind: "tool_call_start", toolName, callId: toolCallId("test-id") };
}

function doneEvent(stopReason: EngineOutput["stopReason"]): EngineEvent {
  return {
    kind: "done",
    output: {
      content: [],
      stopReason,
      metrics: { inputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0, durationMs: 0 },
    },
  };
}

describe("matchesBreakpoint", () => {
  describe("turn predicate", () => {
    test("matches turn_start", () => {
      expect(matchesBreakpoint({ kind: "turn" }, { event: turnStartEvent(0), turnIndex: 0 })).toBe(
        true,
      );
    });

    test("matches turn_end", () => {
      expect(matchesBreakpoint({ kind: "turn" }, { event: turnEndEvent(0), turnIndex: 0 })).toBe(
        true,
      );
    });

    test("does not match non-turn events", () => {
      expect(
        matchesBreakpoint({ kind: "turn" }, { event: toolCallStartEvent("bash"), turnIndex: 0 }),
      ).toBe(false);
    });

    test("matches specific turnIndex", () => {
      expect(
        matchesBreakpoint(
          { kind: "turn", turnIndex: 3 },
          { event: turnStartEvent(3), turnIndex: 3 },
        ),
      ).toBe(true);
      expect(
        matchesBreakpoint(
          { kind: "turn", turnIndex: 3 },
          { event: turnStartEvent(2), turnIndex: 2 },
        ),
      ).toBe(false);
    });

    test("matches every N turns", () => {
      expect(
        matchesBreakpoint({ kind: "turn", every: 3 }, { event: turnStartEvent(3), turnIndex: 3 }),
      ).toBe(true);
      expect(
        matchesBreakpoint({ kind: "turn", every: 3 }, { event: turnStartEvent(6), turnIndex: 6 }),
      ).toBe(true);
      expect(
        matchesBreakpoint({ kind: "turn", every: 3 }, { event: turnStartEvent(4), turnIndex: 4 }),
      ).toBe(false);
    });

    test("every: 0 never matches", () => {
      expect(
        matchesBreakpoint({ kind: "turn", every: 0 }, { event: turnStartEvent(0), turnIndex: 0 }),
      ).toBe(false);
    });
  });

  describe("tool_call predicate", () => {
    test("matches any tool call when no toolName", () => {
      expect(
        matchesBreakpoint(
          { kind: "tool_call" },
          { event: toolCallStartEvent("bash"), turnIndex: 0 },
        ),
      ).toBe(true);
    });

    test("matches specific toolName", () => {
      expect(
        matchesBreakpoint(
          { kind: "tool_call", toolName: "bash" },
          { event: toolCallStartEvent("bash"), turnIndex: 0 },
        ),
      ).toBe(true);
      expect(
        matchesBreakpoint(
          { kind: "tool_call", toolName: "bash" },
          { event: toolCallStartEvent("glob"), turnIndex: 0 },
        ),
      ).toBe(false);
    });

    test("does not match turn events", () => {
      expect(
        matchesBreakpoint({ kind: "tool_call" }, { event: turnStartEvent(0), turnIndex: 0 }),
      ).toBe(false);
    });
  });

  describe("error predicate", () => {
    test("matches done event with error stopReason", () => {
      expect(
        matchesBreakpoint({ kind: "error" }, { event: doneEvent("error"), turnIndex: 0 }),
      ).toBe(true);
    });

    test("does not match done with completed stopReason", () => {
      expect(
        matchesBreakpoint({ kind: "error" }, { event: doneEvent("completed"), turnIndex: 0 }),
      ).toBe(false);
    });

    test("does not match non-done events", () => {
      expect(matchesBreakpoint({ kind: "error" }, { event: turnStartEvent(0), turnIndex: 0 })).toBe(
        false,
      );
    });
  });

  describe("event_kind predicate", () => {
    test("matches exact event kind", () => {
      expect(
        matchesBreakpoint(
          { kind: "event_kind", eventKind: "turn_start" },
          { event: turnStartEvent(0), turnIndex: 0 },
        ),
      ).toBe(true);
    });

    test("does not match different event kind", () => {
      expect(
        matchesBreakpoint(
          { kind: "event_kind", eventKind: "turn_end" },
          { event: turnStartEvent(0), turnIndex: 0 },
        ),
      ).toBe(false);
    });
  });
});

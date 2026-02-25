import { describe, expect, test } from "bun:test";
import type { EngineEvent } from "@koi/core";
import {
  collectTranscript,
  extractMetrics,
  extractText,
  extractToolCalls,
  lastNTurns,
  summarizeTranscript,
} from "./transcript.js";

function textDelta(delta: string): EngineEvent {
  return { kind: "text_delta", delta };
}

function toolCallStart(toolName: string, callId: string): EngineEvent {
  return { kind: "tool_call_start", toolName, callId } as EngineEvent;
}

function turnStart(index: number): EngineEvent {
  return { kind: "turn_start", turnIndex: index };
}

function turnEnd(index: number): EngineEvent {
  return { kind: "turn_end", turnIndex: index };
}

function doneEvent(tokens: number): EngineEvent {
  return {
    kind: "done",
    output: {
      content: [],
      stopReason: "completed" as const,
      metrics: {
        totalTokens: tokens,
        inputTokens: tokens / 2,
        outputTokens: tokens / 2,
        turns: 1,
        durationMs: 100,
      },
    },
  };
}

describe("collectTranscript", () => {
  test("collects all events from async iterable", async () => {
    async function* gen(): AsyncIterable<EngineEvent> {
      yield textDelta("hello");
      yield textDelta(" world");
    }
    const events = await collectTranscript(gen());
    expect(events).toHaveLength(2);
    expect(events[0]?.kind).toBe("text_delta");
  });

  test("handles empty stream", async () => {
    async function* gen(): AsyncIterable<EngineEvent> {
      // empty
    }
    const events = await collectTranscript(gen());
    expect(events).toHaveLength(0);
  });
});

describe("extractText", () => {
  test("concatenates text deltas", () => {
    const events: readonly EngineEvent[] = [textDelta("hello"), textDelta(" world")];
    expect(extractText(events)).toBe("hello world");
  });

  test("ignores non-text events", () => {
    const events: readonly EngineEvent[] = [
      textDelta("hello"),
      toolCallStart("tool1", "c1"),
      textDelta(" world"),
    ];
    expect(extractText(events)).toBe("hello world");
  });

  test("returns empty string for no text events", () => {
    const events: readonly EngineEvent[] = [toolCallStart("tool1", "c1")];
    expect(extractText(events)).toBe("");
  });
});

describe("extractToolCalls", () => {
  test("extracts tool call summaries", () => {
    const events: readonly EngineEvent[] = [
      toolCallStart("tool1", "c1"),
      toolCallStart("tool2", "c2"),
    ];
    const calls = extractToolCalls(events);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.toolName).toBe("tool1");
    expect(calls[1]?.toolName).toBe("tool2");
  });

  test("returns empty for no tool calls", () => {
    const events: readonly EngineEvent[] = [textDelta("hello")];
    expect(extractToolCalls(events)).toHaveLength(0);
  });
});

describe("extractMetrics", () => {
  test("uses done event metrics when available", () => {
    const events: readonly EngineEvent[] = [textDelta("hello"), doneEvent(100)];
    const metrics = extractMetrics(events, 500);
    expect(metrics.totalTokens).toBe(100);
    expect(metrics.durationMs).toBe(500);
  });

  test("returns fallback metrics when no done event", () => {
    const events: readonly EngineEvent[] = [turnStart(0), textDelta("hello"), turnEnd(0)];
    const metrics = extractMetrics(events, 200);
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.turns).toBe(1);
    expect(metrics.durationMs).toBe(200);
  });
});

describe("summarizeTranscript", () => {
  test("includes input, tools, and output", () => {
    const events: readonly EngineEvent[] = [
      turnStart(0),
      textDelta("hello "),
      textDelta("world"),
      toolCallStart("search", "c1"),
      turnEnd(0),
      turnStart(1),
      textDelta("result"),
      turnEnd(1),
    ];
    const summary = summarizeTranscript(events);
    expect(summary).toContain("Input:");
    expect(summary).toContain("Tools: search");
    expect(summary).toContain("Output:");
  });

  test("handles empty events", () => {
    const summary = summarizeTranscript([]);
    expect(summary).toBe("");
  });
});

describe("lastNTurns", () => {
  test("returns last N turn groups", () => {
    const events: readonly EngineEvent[] = [
      turnStart(0),
      textDelta("turn0"),
      turnEnd(0),
      turnStart(1),
      textDelta("turn1"),
      turnEnd(1),
      turnStart(2),
      textDelta("turn2"),
      turnEnd(2),
    ];
    const last2 = lastNTurns(events, 2);
    const text = extractText(last2);
    expect(text).toContain("turn1");
    expect(text).toContain("turn2");
    expect(text).not.toContain("turn0");
  });

  test("returns all events when fewer turns than N", () => {
    const events: readonly EngineEvent[] = [turnStart(0), textDelta("only"), turnEnd(0)];
    const result = lastNTurns(events, 5);
    expect(result).toHaveLength(3);
  });

  test("falls back to slice for events with no turn markers", () => {
    const events: readonly EngineEvent[] = [textDelta("a"), textDelta("b"), textDelta("c")];
    const result = lastNTurns(events, 2);
    expect(result).toHaveLength(2);
  });
});

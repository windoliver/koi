import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineOutput } from "@koi/core";
import { addTokens, extractIterationTokens } from "./budget.js";

function done(totalTokens: number): EngineEvent {
  const output: EngineOutput = {
    content: [],
    stopReason: "completed",
    metrics: {
      totalTokens,
      inputTokens: 0,
      outputTokens: totalTokens,
      turns: 1,
      durationMs: 0,
    },
  };
  return { kind: "done", output };
}

describe("extractIterationTokens", () => {
  test("returns tokens from the done event", () => {
    expect(extractIterationTokens([{ kind: "text_delta", delta: "hi" }, done(42)])).toBe(42);
  });

  test("returns unmetered when no done event", () => {
    expect(extractIterationTokens([{ kind: "text_delta", delta: "hi" }])).toBe("unmetered");
  });

  test("returns unmetered for empty array", () => {
    expect(extractIterationTokens([])).toBe("unmetered");
  });

  test("returns the last done if multiple present (edge case)", () => {
    expect(extractIterationTokens([done(10), done(99)])).toBe(99);
  });

  test("returns unmetered when the done was synthesized by activity-timeout (#1638)", () => {
    // Synthetic zero-token done from a timed-out iteration must NOT be
    // counted as free spend — that would let repeated timeouts silently
    // bypass `maxBudgetTokens`. The budget module returns "unmetered" so
    // the iteration counts as unknown consumption and budget enforcement
    // fails closed.
    const syntheticDone: EngineEvent = {
      kind: "done",
      output: {
        content: [],
        stopReason: "interrupted",
        metrics: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          turns: 0,
          durationMs: 1_000,
        },
        metadata: {
          terminatedBy: "activity-timeout",
          terminationReason: "idle",
          elapsedMs: 1_000,
          metricsSynthesized: true,
        },
      },
    };
    expect(extractIterationTokens([{ kind: "text_delta", delta: "hi" }, syntheticDone])).toBe(
      "unmetered",
    );
  });
});

describe("addTokens", () => {
  test("number + number", () => {
    expect(addTokens(100, 50)).toBe(150);
  });

  test("unmetered + number becomes number", () => {
    expect(addTokens("unmetered", 50)).toBe(50);
  });

  test("number + unmetered stays number", () => {
    expect(addTokens(100, "unmetered")).toBe(100);
  });

  test("unmetered + unmetered stays unmetered", () => {
    expect(addTokens("unmetered", "unmetered")).toBe("unmetered");
  });
});

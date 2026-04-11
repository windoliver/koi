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

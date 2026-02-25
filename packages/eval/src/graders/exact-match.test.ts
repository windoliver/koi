import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineMetrics } from "@koi/core";
import type { EvalExpectation } from "../types.js";
import { createExactMatchGrader } from "./exact-match.js";

const ZERO_METRICS: EngineMetrics = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 0,
};

function textEvents(text: string): readonly EngineEvent[] {
  return [{ kind: "text_delta", delta: text }];
}

describe("createExactMatchGrader", () => {
  const grader = createExactMatchGrader();

  test("passes on exact string match", () => {
    const events = textEvents("hello world");
    const expected: EvalExpectation = { kind: "text", pattern: "hello world" };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 1, pass: true }));
  });

  test("passes on substring match", () => {
    const events = textEvents("the answer is 42");
    const expected: EvalExpectation = { kind: "text", pattern: "42" };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 1, pass: true }));
  });

  test("fails on mismatch", () => {
    const events = textEvents("hello world");
    const expected: EvalExpectation = { kind: "text", pattern: "goodbye" };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 0, pass: false }));
  });

  test("is case sensitive by default", () => {
    const events = textEvents("Hello World");
    const expected: EvalExpectation = { kind: "text", pattern: "hello world" };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 0, pass: false }));
  });

  test("supports case insensitive mode", () => {
    const caseInsensitive = createExactMatchGrader({ caseSensitive: false });
    const events = textEvents("Hello World");
    const expected: EvalExpectation = { kind: "text", pattern: "hello world" };
    const score = caseInsensitive.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 1, pass: true }));
  });

  test("supports regex patterns", () => {
    const events = textEvents("The answer is 42.");
    const expected: EvalExpectation = {
      kind: "text",
      pattern: /answer is \d+/,
    };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 1, pass: true }));
  });

  test("handles regex mismatch", () => {
    const events = textEvents("no numbers here");
    const expected: EvalExpectation = { kind: "text", pattern: /\d+/ };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 0, pass: false }));
  });

  test("returns 0 when no expectation provided", () => {
    const events = textEvents("hello");
    const score = grader.grade(events, undefined, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 0, pass: false }));
  });

  test("returns 0 for non-text expectation", () => {
    const events = textEvents("hello");
    const expected: EvalExpectation = { kind: "tool_calls", calls: [] };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 0, pass: false }));
  });

  test("handles empty output", () => {
    const events: readonly EngineEvent[] = [];
    const expected: EvalExpectation = { kind: "text", pattern: "something" };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 0, pass: false }));
  });

  test("handles unicode text", () => {
    const events = textEvents("cafe\u0301");
    const expected: EvalExpectation = { kind: "text", pattern: "cafe\u0301" };
    const score = grader.grade(events, expected, ZERO_METRICS);
    expect(score).toEqual(expect.objectContaining({ score: 1, pass: true }));
  });
});

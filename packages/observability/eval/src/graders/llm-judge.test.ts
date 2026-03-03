import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineMetrics } from "@koi/core";
import type { EvalExpectation } from "../types.js";
import { createLlmJudgeGrader } from "./llm-judge.js";

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

describe("createLlmJudgeGrader", () => {
  test("parses valid JSON response from model", async () => {
    const grader = createLlmJudgeGrader({
      modelCall: async () => '{"score": 0.8, "reasoning": "Good output"}',
      rubric: "Is the output helpful?",
    });

    const events = textEvents("hello world");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0.8);
    expect(score.pass).toBe(true);
    expect(score.reasoning).toBe("Good output");
  });

  test("handles score below pass threshold", async () => {
    const grader = createLlmJudgeGrader({
      modelCall: async () => '{"score": 0.3, "reasoning": "Poor output"}',
      rubric: "Is the output helpful?",
    });

    const events = textEvents("bad");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0.3);
    expect(score.pass).toBe(false);
  });

  test("handles malformed JSON response", async () => {
    const grader = createLlmJudgeGrader({
      modelCall: async () => "this is not json at all",
      rubric: "Is the output helpful?",
    });

    const events = textEvents("hello");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.pass).toBe(false);
    expect(score.reasoning).toContain("Failed to parse");
  });

  test("handles model call error", async () => {
    const grader = createLlmJudgeGrader({
      modelCall: async () => {
        throw new Error("API timeout");
      },
      rubric: "Is the output helpful?",
    });

    const events = textEvents("hello");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.pass).toBe(false);
    expect(score.reasoning).toContain("API timeout");
  });

  test("uses custom parseScore function", async () => {
    const grader = createLlmJudgeGrader({
      modelCall: async () => "Score: 9/10",
      rubric: "Rate the output",
      parseScore: (response) => {
        const match = /(\d+)\/10/.exec(response);
        return match?.[1] !== undefined ? Number(match[1]) / 10 : 0;
      },
    });

    const events = textEvents("great answer");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0.9);
    expect(score.pass).toBe(true);
  });

  test("clamps score to [0, 1] range", async () => {
    const grader = createLlmJudgeGrader({
      modelCall: async () => '{"score": 1.5, "reasoning": "over the top"}',
      rubric: "Rate",
    });

    const events = textEvents("hello");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(1);
  });

  test("includes expected text in prompt when provided", async () => {
    // let justified: capturing prompt for assertion
    let capturedPrompt = "";

    const grader = createLlmJudgeGrader({
      modelCall: async (prompt) => {
        capturedPrompt = prompt;
        return '{"score": 0.8, "reasoning": "ok"}';
      },
      rubric: "Check accuracy",
    });

    const events = textEvents("answer is 42");
    const expected: EvalExpectation = { kind: "text", pattern: "42" };
    await grader.grade(events, expected, ZERO_METRICS);

    expect(capturedPrompt).toContain("42");
    expect(capturedPrompt).toContain("Expected Output");
  });

  test("uses summary transcript mode", async () => {
    // let justified: capturing prompt for assertion
    let capturedPrompt = "";

    const grader = createLlmJudgeGrader({
      modelCall: async (prompt) => {
        capturedPrompt = prompt;
        return '{"score": 1, "reasoning": "good"}';
      },
      rubric: "Rate",
      transcriptMode: "summary",
    });

    const events: readonly EngineEvent[] = [
      { kind: "turn_start", turnIndex: 0 },
      { kind: "text_delta", delta: "hello" },
      { kind: "tool_call_start", toolName: "search", callId: "c1" } as EngineEvent,
      { kind: "turn_end", turnIndex: 0 },
    ];
    await grader.grade(events, undefined, ZERO_METRICS);

    expect(capturedPrompt).toContain("Tools: search");
  });

  test("extracts JSON from markdown code block in response", async () => {
    const grader = createLlmJudgeGrader({
      modelCall: async () =>
        'Here is my assessment:\n```json\n{"score": 0.75, "reasoning": "decent"}\n```',
      rubric: "Rate",
    });

    const events = textEvents("hello");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0.75);
  });
});

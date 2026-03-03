import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineMetrics } from "@koi/core";
import { toolCallId } from "@koi/core";
import type { EvalExpectation } from "../types.js";
import { createToolCallGrader } from "./tool-call.js";

const ZERO_METRICS: EngineMetrics = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 0,
};

function toolCallEvents(names: readonly string[]): readonly EngineEvent[] {
  return names.map((name, i) => ({
    kind: "tool_call_start" as const,
    toolName: name,
    callId: toolCallId(`c${String(i)}`),
  })) as readonly EngineEvent[];
}

describe("createToolCallGrader", () => {
  const grader = createToolCallGrader();

  test("passes when expected tools match actual", async () => {
    const events = toolCallEvents(["search", "calculate"]);
    const expected: EvalExpectation = {
      kind: "tool_calls",
      calls: [{ toolName: "search" }, { toolName: "calculate" }],
    };
    const score = await grader.grade(events, expected, ZERO_METRICS);
    expect(score.score).toBe(1);
    expect(score.pass).toBe(true);
  });

  test("scores partial match with Jaccard", async () => {
    const events = toolCallEvents(["search", "extra"]);
    const expected: EvalExpectation = {
      kind: "tool_calls",
      calls: [{ toolName: "search" }, { toolName: "calculate" }],
    };
    const score = await grader.grade(events, expected, ZERO_METRICS);
    // Jaccard: intersection=1(search), union=3(search,extra,calculate) → 1/3
    expect(score.score).toBeCloseTo(1 / 3, 2);
    expect(score.pass).toBe(false);
  });

  test("scores 0 when no expected tools are found", async () => {
    const events = toolCallEvents(["unrelated"]);
    const expected: EvalExpectation = {
      kind: "tool_calls",
      calls: [{ toolName: "search" }],
    };
    const score = await grader.grade(events, expected, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.pass).toBe(false);
  });

  test("returns score 1 when both empty", async () => {
    const expected: EvalExpectation = { kind: "tool_calls", calls: [] };
    const score = await grader.grade([], expected, ZERO_METRICS);
    expect(score.score).toBe(1);
    expect(score.pass).toBe(true);
  });

  test("returns 0 for non-tool_calls expectation", async () => {
    const score = await grader.grade([], undefined, ZERO_METRICS);
    expect(score.pass).toBe(false);
  });

  test("handles extra actual calls", async () => {
    const events = toolCallEvents(["search", "extra1", "extra2"]);
    const expected: EvalExpectation = {
      kind: "tool_calls",
      calls: [{ toolName: "search" }],
    };
    const score = await grader.grade(events, expected, ZERO_METRICS);
    // Jaccard: 1/3
    expect(score.score).toBeCloseTo(1 / 3, 2);
  });
});

describe("createToolCallGrader with strict order", () => {
  const grader = createToolCallGrader({ orderStrict: true });

  test("passes when tools in correct order", async () => {
    const events = toolCallEvents(["search", "calculate"]);
    const expected: EvalExpectation = {
      kind: "tool_calls",
      calls: [{ toolName: "search" }, { toolName: "calculate" }],
    };
    const score = await grader.grade(events, expected, ZERO_METRICS);
    expect(score.score).toBe(1);
    expect(score.pass).toBe(true);
  });

  test("fails when tools in wrong order", async () => {
    const events = toolCallEvents(["calculate", "search"]);
    const expected: EvalExpectation = {
      kind: "tool_calls",
      calls: [{ toolName: "search" }, { toolName: "calculate" }],
    };
    const score = await grader.grade(events, expected, ZERO_METRICS);
    // Only "calculate" matches (search comes before it in expected but after in actual)
    expect(score.score).toBeLessThan(1);
  });
});

describe("tool call arg matching", () => {
  const grader = createToolCallGrader();

  test("matches when args match", async () => {
    const events: readonly EngineEvent[] = [
      {
        kind: "tool_call_start",
        toolName: "search",
        callId: toolCallId("c0"),
        args: { query: "test" },
      },
    ];
    const expected: EvalExpectation = {
      kind: "tool_calls",
      calls: [{ toolName: "search", args: { query: "test" } }],
    };
    const score = await grader.grade(events, expected, ZERO_METRICS);
    expect(score.score).toBe(1);
  });

  test("penalizes arg mismatches", async () => {
    const events: readonly EngineEvent[] = [
      {
        kind: "tool_call_start",
        toolName: "search",
        callId: toolCallId("c0"),
        args: { query: "wrong" },
      },
    ];
    const expected: EvalExpectation = {
      kind: "tool_calls",
      calls: [{ toolName: "search", args: { query: "test" } }],
    };
    const score = await grader.grade(events, expected, ZERO_METRICS);
    expect(score.score).toBeLessThan(1);
  });
});

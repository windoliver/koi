import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineMetrics, ToolCallId } from "@koi/core";
import { toolCall } from "./tool-call.js";

const METRICS: EngineMetrics = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 0,
};

const callStart = (toolName: string, args?: Readonly<Record<string, unknown>>): EngineEvent => ({
  kind: "tool_call_start",
  toolName,
  callId: `${toolName}-id` as ToolCallId,
  ...(args !== undefined ? { args } : {}),
});

const callResult = (toolName: string): EngineEvent => ({
  kind: "tool_result",
  callId: `${toolName}-id` as ToolCallId,
  output: "ok",
});

const completed = (toolName: string, args?: Readonly<Record<string, unknown>>): EngineEvent[] => [
  callStart(toolName, args),
  callResult(toolName),
];

describe("toolCall", () => {
  test("passes when expected calls present (any-order)", async () => {
    const grader = toolCall();
    const events: readonly EngineEvent[] = [...completed("read"), ...completed("write")];
    const score = await grader.grade(
      events,
      { kind: "tool_calls", calls: [{ toolName: "write" }, { toolName: "read" }] },
      METRICS,
    );
    expect(score.pass).toBe(true);
    expect(score.score).toBe(1);
  });

  test("fails when expected call missing", async () => {
    const grader = toolCall();
    const events: readonly EngineEvent[] = [...completed("read")];
    const score = await grader.grade(
      events,
      { kind: "tool_calls", calls: [{ toolName: "read" }, { toolName: "write" }] },
      METRICS,
    );
    expect(score.pass).toBe(false);
    expect(score.score).toBe(0.5);
    expect(score.reasoning).toContain("write");
  });

  test("matches args when specified", async () => {
    const grader = toolCall();
    const events: readonly EngineEvent[] = [...completed("read", { path: "/a" })];
    const matchScore = await grader.grade(
      events,
      { kind: "tool_calls", calls: [{ toolName: "read", args: { path: "/a" } }] },
      METRICS,
    );
    expect(matchScore.pass).toBe(true);
    const failScore = await grader.grade(
      events,
      { kind: "tool_calls", calls: [{ toolName: "read", args: { path: "/b" } }] },
      METRICS,
    );
    expect(failScore.pass).toBe(false);
  });

  test("matches nested args structurally, not by reference", async () => {
    const grader = toolCall();
    const events: readonly EngineEvent[] = [
      ...completed("search", { filter: { q: "x", tags: ["a", "b"] } }),
    ];
    const score = await grader.grade(
      events,
      {
        kind: "tool_calls",
        calls: [{ toolName: "search", args: { filter: { q: "x", tags: ["a", "b"] } } }],
      },
      METRICS,
    );
    expect(score.pass).toBe(true);
  });

  test("nested args use recursive subset (extra observed keys are tolerated)", async () => {
    const grader = toolCall();
    // Tool added a new optional `meta.requestId` field; old expectations
    // should still pass as long as the expected fields still match.
    const events: readonly EngineEvent[] = [
      ...completed("search", { filter: { q: "x" }, meta: { requestId: "r1" } }),
    ];
    const score = await grader.grade(
      events,
      { kind: "tool_calls", calls: [{ toolName: "search", args: { filter: { q: "x" } } }] },
      METRICS,
    );
    expect(score.pass).toBe(true);
  });

  test("strict order requires sequential match", async () => {
    const grader = toolCall({ order: "strict" });
    const eventsBad: readonly EngineEvent[] = [...completed("write"), ...completed("read")];
    const score = await grader.grade(
      eventsBad,
      { kind: "tool_calls", calls: [{ toolName: "read" }, { toolName: "write" }] },
      METRICS,
    );
    expect(score.pass).toBe(false);
  });

  test("tool_call_end without tool_result does not count as execution", async () => {
    const grader = toolCall();
    const events: readonly EngineEvent[] = [
      callStart("read"),
      { kind: "tool_call_end", callId: "read-id" as ToolCallId, result: { ok: true } },
    ];
    const score = await grader.grade(
      events,
      { kind: "tool_calls", calls: [{ toolName: "read" }] },
      METRICS,
    );
    expect(score.pass).toBe(false);
  });

  test("does not pass on intent alone (tool_call_start without tool_result)", async () => {
    const grader = toolCall();
    const events: readonly EngineEvent[] = [callStart("read")];
    const score = await grader.grade(
      events,
      { kind: "tool_calls", calls: [{ toolName: "read" }] },
      METRICS,
    );
    expect(score.pass).toBe(false);
  });

  test("returns no-expectation reasoning when missing", async () => {
    const grader = toolCall();
    const score = await grader.grade([], undefined, METRICS);
    expect(score.pass).toBe(false);
    expect(score.reasoning).toContain("no tool_calls expectation");
  });
});

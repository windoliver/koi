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

describe("toolCall", () => {
  test("passes when expected calls present (any-order)", async () => {
    const grader = toolCall();
    const events: readonly EngineEvent[] = [callStart("read"), callStart("write")];
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
    const events: readonly EngineEvent[] = [callStart("read")];
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
    const events: readonly EngineEvent[] = [callStart("read", { path: "/a" })];
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

  test("strict order requires sequential match", async () => {
    const grader = toolCall({ order: "strict" });
    const eventsBad: readonly EngineEvent[] = [callStart("write"), callStart("read")];
    const score = await grader.grade(
      eventsBad,
      { kind: "tool_calls", calls: [{ toolName: "read" }, { toolName: "write" }] },
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

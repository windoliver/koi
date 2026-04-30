import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineMetrics } from "@koi/core";
import { exactMatch } from "./exact-match.js";

const METRICS: EngineMetrics = {
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  turns: 0,
  durationMs: 0,
};

const transcript = (text: string): readonly EngineEvent[] => [{ kind: "text_delta", delta: text }];

describe("exactMatch", () => {
  test("passes when string substring matches", async () => {
    const grader = exactMatch();
    const score = await grader.grade(
      transcript("hello world"),
      { kind: "text", pattern: "world" },
      METRICS,
    );
    expect(score.pass).toBe(true);
    expect(score.score).toBe(1);
  });

  test("fails when string substring missing", async () => {
    const grader = exactMatch();
    const score = await grader.grade(
      transcript("hello world"),
      { kind: "text", pattern: "goodbye" },
      METRICS,
    );
    expect(score.pass).toBe(false);
    expect(score.score).toBe(0);
  });

  test("passes when regex matches", async () => {
    const grader = exactMatch();
    const score = await grader.grade(
      transcript("Hello, World"),
      { kind: "text", pattern: /hello/i },
      METRICS,
    );
    expect(score.pass).toBe(true);
  });

  test("uses fallback pattern when expectation missing", async () => {
    const grader = exactMatch({ pattern: "yes" });
    const score = await grader.grade(transcript("yes please"), undefined, METRICS);
    expect(score.pass).toBe(true);
  });

  test("returns no-pattern reasoning when neither provided", async () => {
    const grader = exactMatch();
    const score = await grader.grade(transcript("anything"), undefined, METRICS);
    expect(score.pass).toBe(false);
    expect(score.reasoning).toContain("no text expectation");
  });

  test("concatenates text_delta events into final string", async () => {
    const grader = exactMatch();
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "hello " },
      { kind: "text_delta", delta: "world" },
    ];
    const score = await grader.grade(events, { kind: "text", pattern: "hello world" }, METRICS);
    expect(score.pass).toBe(true);
  });

  test("falls back to done.output.content when no text_delta", async () => {
    const grader = exactMatch();
    const events: readonly EngineEvent[] = [
      {
        kind: "done",
        output: {
          content: [{ kind: "text", text: "final answer" }],
          stopReason: "completed",
          metrics: METRICS,
        },
      },
    ];
    const score = await grader.grade(events, { kind: "text", pattern: "final" }, METRICS);
    expect(score.pass).toBe(true);
  });

  test("done.output.content takes precedence over streamed text_delta (sanitization-aware)", async () => {
    const grader = exactMatch();
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "SECRET_DATA_LEAKED" },
      {
        kind: "done",
        output: {
          content: [{ kind: "text", text: "[redacted]" }],
          stopReason: "completed",
          metrics: METRICS,
        },
      },
    ];
    const leaked = await grader.grade(events, { kind: "text", pattern: "SECRET" }, METRICS);
    expect(leaked.pass).toBe(false);
    const sanitized = await grader.grade(events, { kind: "text", pattern: "redacted" }, METRICS);
    expect(sanitized.pass).toBe(true);
  });

  test("does not fall back to tool_result by default", async () => {
    const grader = exactMatch();
    const events: readonly EngineEvent[] = [
      { kind: "tool_result", callId: "c1" as never, output: { rows: 42 } },
    ];
    const score = await grader.grade(events, { kind: "text", pattern: "42" }, METRICS);
    expect(score.pass).toBe(false);
  });

  test("falls back to tool_result output when includeToolResults: true", async () => {
    const grader = exactMatch({ includeToolResults: true });
    const events: readonly EngineEvent[] = [
      { kind: "tool_result", callId: "c1" as never, output: { rows: 42 } },
    ];
    const score = await grader.grade(events, { kind: "text", pattern: "42" }, METRICS);
    expect(score.pass).toBe(true);
  });

  test("regex with global flag matches deterministically across calls", async () => {
    const grader = exactMatch();
    const pattern = /hello/g;
    const expected = { kind: "text" as const, pattern };
    const first = await grader.grade(transcript("hello world"), expected, METRICS);
    const second = await grader.grade(transcript("hello world"), expected, METRICS);
    expect(first.pass).toBe(true);
    expect(second.pass).toBe(true);
  });

  test("does not fall back to tool_result when done has non-text content (visibility)", async () => {
    // includeToolResults=true must NOT match raw tool output when the
    // user-visible final response is a structured non-text block. The user
    // never saw the tool data; matching against it would be a false pass.
    const grader = exactMatch({ includeToolResults: true });
    const events: readonly EngineEvent[] = [
      { kind: "tool_result", callId: "c1" as never, output: { rows: 42 } },
      {
        kind: "done",
        output: {
          content: [{ kind: "image", url: "https://example.test/x.png" }],
          stopReason: "completed",
          metrics: METRICS,
        },
      },
    ];
    const score = await grader.grade(events, { kind: "text", pattern: "42" }, METRICS);
    expect(score.pass).toBe(false);
  });

  test("done with empty content array does not fall back to streamed deltas", async () => {
    // Empty content can mean "redacted by middleware" — falling back to
    // streamed text would let pre-sanitized content slip through.
    const grader = exactMatch();
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "streamed answer" },
      {
        kind: "done",
        output: { content: [], stopReason: "completed", metrics: METRICS },
      },
    ];
    const score = await grader.grade(events, { kind: "text", pattern: "streamed" }, METRICS);
    expect(score.pass).toBe(false);
  });

  test("does not fall back to text_delta when done has non-text content blocks", async () => {
    const grader = exactMatch();
    const events: readonly EngineEvent[] = [
      { kind: "text_delta", delta: "SECRET_LEAK" },
      {
        kind: "done",
        output: {
          content: [{ kind: "image", url: "https://example.test/x.png" }],
          stopReason: "completed",
          metrics: METRICS,
        },
      },
    ];
    const score = await grader.grade(events, { kind: "text", pattern: "SECRET" }, METRICS);
    expect(score.pass).toBe(false);
  });

  test("uses custom id", () => {
    const grader = exactMatch({ id: "my-grader" });
    expect(grader.id).toBe("my-grader");
  });
});

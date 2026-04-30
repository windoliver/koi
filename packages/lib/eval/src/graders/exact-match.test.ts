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

  test("uses custom id", () => {
    const grader = exactMatch({ id: "my-grader" });
    expect(grader.id).toBe("my-grader");
  });
});

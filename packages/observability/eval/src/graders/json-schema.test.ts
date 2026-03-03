import { describe, expect, test } from "bun:test";
import type { EngineEvent, EngineMetrics } from "@koi/core";
import { createJsonSchemaGrader } from "./json-schema.js";

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

describe("createJsonSchemaGrader", () => {
  const grader = createJsonSchemaGrader({
    schema: {
      type: "object",
      required: ["name", "age"],
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
    },
  });

  test("passes for valid JSON matching schema", async () => {
    const events = textEvents('{"name": "Alice", "age": 30}');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(1);
    expect(score.pass).toBe(true);
  });

  test("fails for missing required field", async () => {
    const events = textEvents('{"name": "Alice"}');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.pass).toBe(false);
    expect(score.reasoning).toContain("age");
  });

  test("fails for wrong type", async () => {
    const events = textEvents('{"name": 123, "age": 30}');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.reasoning).toContain("expected string");
  });

  test("fails for non-JSON output", async () => {
    const events = textEvents("this is not json");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.reasoning).toContain("parse JSON");
  });

  test("handles JSON in markdown code block", async () => {
    const events = textEvents('```json\n{"name": "Bob", "age": 25}\n```');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(1);
    expect(score.pass).toBe(true);
  });

  test("handles empty output", async () => {
    const events: readonly EngineEvent[] = [];
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.pass).toBe(false);
  });
});

describe("nested object validation", () => {
  const grader = createJsonSchemaGrader({
    schema: {
      type: "object",
      required: ["user"],
      properties: {
        user: {
          type: "object",
          required: ["id"],
          properties: {
            id: { type: "number" },
          },
        },
      },
    },
  });

  test("validates nested objects", async () => {
    const events = textEvents('{"user": {"id": 1}}');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(1);
  });

  test("fails for missing nested required", async () => {
    const events = textEvents('{"user": {}}');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.reasoning).toContain("id");
  });
});

describe("array validation", () => {
  const grader = createJsonSchemaGrader({
    schema: {
      type: "array",
      items: { type: "number" },
    },
  });

  test("validates array items", async () => {
    const events = textEvents("[1, 2, 3]");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(1);
  });

  test("fails for wrong item type", async () => {
    const events = textEvents('[1, "two", 3]');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.reasoning).toContain("expected number");
  });
});

describe("numeric constraints", () => {
  const grader = createJsonSchemaGrader({
    schema: {
      type: "number",
      minimum: 0,
      maximum: 100,
    },
  });

  test("passes for value in range", async () => {
    const events = textEvents("50");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(1);
  });

  test("fails for value below minimum", async () => {
    const events = textEvents("-1");
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.reasoning).toContain("minimum");
  });
});

describe("string constraints", () => {
  const grader = createJsonSchemaGrader({
    schema: {
      type: "string",
      minLength: 2,
      maxLength: 5,
    },
  });

  test("passes for valid length", async () => {
    const events = textEvents('"abc"');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(1);
  });

  test("fails for string too short", async () => {
    const events = textEvents('"a"');
    const score = await grader.grade(events, undefined, ZERO_METRICS);
    expect(score.score).toBe(0);
    expect(score.reasoning).toContain("minLength");
  });
});

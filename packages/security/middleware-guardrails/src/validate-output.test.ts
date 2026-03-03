/**
 * Unit tests for output validation logic (JSON/text parsing + Zod schemas).
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import type { GuardrailRule } from "./types.js";
import { validateModelOutput, validateToolOutput } from "./validate-output.js";

const jsonSchema = z.object({
  message: z.string(),
  score: z.number().min(0).max(100),
});

const textSchema = z.object({
  text: z.string().min(1),
});

function makeRule(overrides: Partial<GuardrailRule> & { readonly name: string }): GuardrailRule {
  return {
    schema: jsonSchema,
    target: "modelOutput",
    action: "block",
    ...overrides,
  };
}

describe("validateModelOutput", () => {
  describe("JSON mode", () => {
    const rules = [makeRule({ name: "json-rule" })];

    test("returns valid for conforming JSON", () => {
      const result = validateModelOutput(
        JSON.stringify({ message: "hello", score: 42 }),
        rules,
        "json",
      );
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("returns invalid for non-conforming JSON", () => {
      const result = validateModelOutput(
        JSON.stringify({ message: "hello", score: 200 }),
        rules,
        "json",
      );
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.failedRule).toBe("json-rule");
    });

    test("returns invalid for unparseable JSON", () => {
      const result = validateModelOutput("not json{", rules, "json");
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.code).toBe("invalid_json");
      expect(result.failedRule).toBe("json-rule");
    });

    test("returns invalid for partial JSON", () => {
      const result = validateModelOutput('{"message": "hello"', rules, "json");
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.code).toBe("invalid_json");
    });

    test("truncates long content in JSON parse error message", () => {
      const longContent = "x".repeat(200);
      const result = validateModelOutput(longContent, rules, "json");
      expect(result.valid).toBe(false);
      expect(result.errors[0]?.message.length).toBeLessThan(200);
    });
  });

  describe("text mode", () => {
    const rules = [makeRule({ name: "text-rule", schema: textSchema })];

    test("returns valid for non-empty text", () => {
      const result = validateModelOutput("hello world", rules, "text");
      expect(result.valid).toBe(true);
    });

    test("returns invalid for empty text (schema min 1)", () => {
      const result = validateModelOutput("", rules, "text");
      expect(result.valid).toBe(false);
      expect(result.failedRule).toBe("text-rule");
    });

    test("wraps text in { text: content } before validation", () => {
      const schema = z.object({ text: z.string().includes("expected") });
      const rules = [makeRule({ name: "wrapper-test", schema })];
      const result = validateModelOutput("expected content", rules, "text");
      expect(result.valid).toBe(true);
    });
  });

  describe("edge cases", () => {
    test("returns valid for empty rules", () => {
      const result = validateModelOutput("anything", [], "json");
      expect(result.valid).toBe(true);
    });

    test("fails fast on first failing rule", () => {
      const rules = [
        makeRule({ name: "first", schema: z.object({ a: z.string() }) }),
        makeRule({ name: "second", schema: z.object({ b: z.string() }) }),
      ];
      const result = validateModelOutput(JSON.stringify({ b: "ok" }), rules, "json");
      expect(result.valid).toBe(false);
      expect(result.failedRule).toBe("first");
    });

    test("validates against all rules when earlier pass", () => {
      const rules = [
        makeRule({ name: "first", schema: z.object({ a: z.string() }) }),
        makeRule({ name: "second", schema: z.object({ b: z.number() }) }),
      ];
      const result = validateModelOutput(
        JSON.stringify({ a: "ok", b: "not-a-number" }),
        rules,
        "json",
      );
      expect(result.valid).toBe(false);
      expect(result.failedRule).toBe("second");
    });

    test("defaults parseMode to json", () => {
      const rules = [makeRule({ name: "default-mode" })];
      const result = validateModelOutput(JSON.stringify({ message: "hello", score: 50 }), rules);
      expect(result.valid).toBe(true);
    });
  });
});

describe("validateToolOutput", () => {
  const schema = z.object({ result: z.string(), count: z.number() });
  const rules = [makeRule({ name: "tool-rule", schema, target: "toolOutput" })];

  test("returns valid for conforming output", () => {
    const result = validateToolOutput({ result: "ok", count: 5 }, rules);
    expect(result.valid).toBe(true);
  });

  test("returns invalid for non-conforming output", () => {
    const result = validateToolOutput({ result: 123 }, rules);
    expect(result.valid).toBe(false);
    expect(result.failedRule).toBe("tool-rule");
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("returns valid for empty rules", () => {
    const result = validateToolOutput("anything", []);
    expect(result.valid).toBe(true);
  });

  test("validates directly without JSON parsing", () => {
    const stringSchema = z.string();
    const rules = [makeRule({ name: "string-rule", schema: stringSchema, target: "toolOutput" })];
    const result = validateToolOutput("hello", rules);
    expect(result.valid).toBe(true);
  });
});

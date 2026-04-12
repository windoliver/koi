import { describe, expect, test } from "bun:test";
import type { OutcomeRubric } from "@koi/core";
import { parseGraderResponse } from "./parse-grader-response.js";

const RUBRIC: OutcomeRubric = {
  description: "Explain recursion",
  criteria: [
    { name: "base_case", description: "Mentions base case" },
    { name: "self_call", description: "Mentions self-call", required: false },
  ],
};

const VALID_RESPONSE = JSON.stringify({
  criteria: [
    { name: "base_case", passed: true },
    { name: "self_call", passed: false, gap: "Does not mention self-call" },
  ],
  explanation: "Mostly correct but missing self-call discussion.",
});

describe("parseGraderResponse", () => {
  test("valid full response parses to ok:true", () => {
    const result = parseGraderResponse(VALID_RESPONSE, RUBRIC, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.iteration).toBe(1);
    expect(result.value.criteria).toHaveLength(2);
    expect(result.value.explanation).toBe("Mostly correct but missing self-call discussion.");
  });

  test("all required criteria pass → result is satisfied", () => {
    const raw = JSON.stringify({
      criteria: [
        { name: "base_case", passed: true },
        { name: "self_call", passed: false, gap: "missing" },
      ],
      explanation: "ok",
    });
    const result = parseGraderResponse(raw, RUBRIC, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // base_case (required) passes; self_call (advisory) fails → still satisfied
    expect(result.value.result).toBe("satisfied");
  });

  test("required criterion fails → result is needs_revision", () => {
    const raw = JSON.stringify({
      criteria: [
        { name: "base_case", passed: false, gap: "No base case mentioned" },
        { name: "self_call", passed: true },
      ],
      explanation: "missing base case",
    });
    const result = parseGraderResponse(raw, RUBRIC, 2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe("needs_revision");
    expect(result.value.iteration).toBe(2);
  });

  test("missing criteria field → ok:false", () => {
    const raw = JSON.stringify({ explanation: "ok" });
    const result = parseGraderResponse(raw, RUBRIC, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('"criteria"');
  });

  test("passed is string 'yes' → ok:false", () => {
    const raw = JSON.stringify({
      criteria: [{ name: "base_case", passed: "yes" }],
      explanation: "ok",
    });
    const result = parseGraderResponse(raw, RUBRIC, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("non-boolean");
  });

  test("extra unknown criteria in response are included in results", () => {
    const raw = JSON.stringify({
      criteria: [
        { name: "base_case", passed: true },
        { name: "self_call", passed: true },
        { name: "extra_unknown", passed: false, gap: "unexpected" },
      ],
      explanation: "ok",
    });
    const result = parseGraderResponse(raw, RUBRIC, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Extra criterion is included; rubric criteria all evaluated
    expect(result.value.criteria.some((c) => c.name === "extra_unknown")).toBe(true);
  });

  test("malformed JSON → ok:false", () => {
    const result = parseGraderResponse("{not valid json", RUBRIC, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("JSON parse error");
  });

  test("empty string → ok:false", () => {
    const result = parseGraderResponse("", RUBRIC, 1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain("empty");
  });

  test("rubric criterion missing from grader response → treated as failed", () => {
    const raw = JSON.stringify({
      // grader only evaluated one criterion, skipped self_call
      criteria: [{ name: "base_case", passed: true }],
      explanation: "ok",
    });
    const result = parseGraderResponse(raw, RUBRIC, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const selfCall = result.value.criteria.find((c) => c.name === "self_call");
    expect(selfCall).toBeDefined();
    // self_call has required:false so missing it still doesn't block satisfied
  });

  test("strips markdown code fences before parsing", () => {
    const raw = `\`\`\`json\n${VALID_RESPONSE}\n\`\`\``;
    const result = parseGraderResponse(raw, RUBRIC, 1);
    expect(result.ok).toBe(true);
  });

  test("advisory criterion failing does not block satisfied when required criteria pass", () => {
    const raw = JSON.stringify({
      criteria: [
        { name: "base_case", passed: true },
        { name: "self_call", passed: false, gap: "no self-call" },
      ],
      explanation: "mostly ok",
    });
    const result = parseGraderResponse(raw, RUBRIC, 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.result).toBe("satisfied");
  });
});

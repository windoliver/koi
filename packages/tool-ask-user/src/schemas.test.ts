import { describe, expect, it } from "bun:test";
import type { ElicitationQuestion } from "@koi/core/elicitation";
import { createQuestionSchema, validateHandlerResponse, validateQuestionInput } from "./schemas.js";

describe("validateQuestionInput", () => {
  const schema6 = createQuestionSchema(6);
  const schema3 = createQuestionSchema(3);

  const validInput = {
    question: "Which approach?",
    options: [
      { label: "A", description: "Option A" },
      { label: "B", description: "Option B" },
    ],
  };

  it("accepts valid input", () => {
    const result = validateQuestionInput(validInput, schema6);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.question).toBe("Which approach?");
      expect(result.value.options).toHaveLength(2);
    }
  });

  it("accepts input with all optional fields", () => {
    const result = validateQuestionInput(
      { ...validInput, header: "Approach", multiSelect: true },
      schema6,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.header).toBe("Approach");
      expect(result.value.multiSelect).toBe(true);
    }
  });

  it("rejects missing question field", () => {
    const result = validateQuestionInput({ options: validInput.options }, schema6);
    expect(result.ok).toBe(false);
  });

  it("rejects empty options array", () => {
    const result = validateQuestionInput({ question: "Which?", options: [] }, schema6);
    expect(result.ok).toBe(false);
  });

  it("rejects single option (needs at least 2)", () => {
    const result = validateQuestionInput(
      {
        question: "Which?",
        options: [{ label: "Only", description: "Only one" }],
      },
      schema6,
    );
    expect(result.ok).toBe(false);
  });

  it("rejects options exceeding maxOptions", () => {
    const manyOptions = Array.from({ length: 4 }, (_, i) => ({
      label: `Option ${String(i)}`,
      description: `Desc ${String(i)}`,
    }));
    const result = validateQuestionInput({ question: "Which?", options: manyOptions }, schema3);
    expect(result.ok).toBe(false);
  });

  it("rejects header exceeding 12 characters", () => {
    const result = validateQuestionInput({ ...validInput, header: "This is too long" }, schema6);
    expect(result.ok).toBe(false);
  });

  it("rejects option with missing label", () => {
    const result = validateQuestionInput(
      {
        question: "Which?",
        options: [{ description: "No label" }, { label: "B", description: "Has label" }],
      },
      schema6,
    );
    expect(result.ok).toBe(false);
  });

  it("strips extra fields from input", () => {
    const result = validateQuestionInput({ ...validInput, extraField: "ignored" }, schema6);
    expect(result.ok).toBe(true);
  });
});

describe("validateHandlerResponse", () => {
  const question: ElicitationQuestion = {
    question: "Which approach?",
    options: [
      { label: "A", description: "Option A" },
      { label: "B", description: "Option B" },
      { label: "C", description: "Option C" },
    ],
  };

  const multiQuestion: ElicitationQuestion = {
    ...question,
    multiSelect: true,
  };

  it("accepts valid single selection", () => {
    const result = validateHandlerResponse({ selected: ["A"] }, question);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.selected).toEqual(["A"]);
    }
  });

  it("accepts valid multi-selection", () => {
    const result = validateHandlerResponse({ selected: ["A", "B"] }, multiQuestion);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.selected).toEqual(["A", "B"]);
    }
  });

  it("accepts free-text only response", () => {
    const result = validateHandlerResponse({ selected: [], freeText: "Custom answer" }, question);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.freeText).toBe("Custom answer");
    }
  });

  it("rejects empty response (no selection and no freeText)", () => {
    const result = validateHandlerResponse({ selected: [] }, question);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("VALIDATION");
    }
  });

  it("rejects multiple selections when multiSelect is false", () => {
    const result = validateHandlerResponse({ selected: ["A", "B"] }, question);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("multiple selections not allowed");
    }
  });

  it("rejects unknown option labels without freeText", () => {
    const result = validateHandlerResponse({ selected: ["Unknown"] }, question);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unknown option(s)");
    }
  });

  it("accepts unknown labels when freeText is provided as escape hatch", () => {
    const result = validateHandlerResponse(
      { selected: ["Unknown"], freeText: "I want something else" },
      question,
    );
    expect(result.ok).toBe(true);
  });
});

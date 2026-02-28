import { describe, expect, it } from "bun:test";
import type { ElicitationOption, ElicitationQuestion, ElicitationResult } from "./elicitation.js";

describe("ElicitationOption", () => {
  it("accepts a valid option", () => {
    const option = {
      label: "Use Redis",
      description: "In-memory cache with persistence support",
    } satisfies ElicitationOption;

    expect(option.label).toBe("Use Redis");
    expect(option.description).toBe("In-memory cache with persistence support");
  });
});

describe("ElicitationQuestion", () => {
  it("accepts a full question with all fields", () => {
    const question = {
      question: "Which caching strategy should we use?",
      header: "Cache",
      options: [
        { label: "Redis", description: "Distributed cache" },
        { label: "In-memory", description: "Local process cache" },
      ],
      multiSelect: false,
    } satisfies ElicitationQuestion;

    expect(question.question).toBe("Which caching strategy should we use?");
    expect(question.header).toBe("Cache");
    expect(question.options).toHaveLength(2);
    expect(question.multiSelect).toBe(false);
  });

  it("accepts a minimal question with only required fields", () => {
    const question: ElicitationQuestion = {
      question: "Which approach?",
      options: [
        { label: "A", description: "Option A" },
        { label: "B", description: "Option B" },
      ],
    };

    expect(question.header).toBeUndefined();
    expect(question.multiSelect).toBeUndefined();
  });
});

describe("ElicitationResult", () => {
  it("accepts a single selection", () => {
    const result: ElicitationResult = {
      selected: ["Redis"],
    };

    expect(result.selected).toEqual(["Redis"]);
    expect(result.freeText).toBeUndefined();
  });

  it("accepts multiple selections", () => {
    const result = {
      selected: ["Redis", "In-memory"],
    } satisfies ElicitationResult;

    expect(result.selected).toHaveLength(2);
  });

  it("accepts free-text only response", () => {
    const result = {
      selected: [],
      freeText: "I want a custom approach",
    } satisfies ElicitationResult;

    expect(result.selected).toHaveLength(0);
    expect(result.freeText).toBe("I want a custom approach");
  });
});

import { describe, expect, test } from "bun:test";
import type { OutcomeRubric } from "@koi/core";
import { buildGraderPrompt } from "./prompt-builder.js";

const RUBRIC: OutcomeRubric = {
  description: "Explain recursion clearly",
  criteria: [
    { name: "mentions_base_case", description: "Mentions a base case" },
    { name: "mentions_self_reference", description: "Mentions that a function calls itself" },
  ],
};

describe("buildGraderPrompt", () => {
  test("full rubric prompt includes all criterion names", () => {
    const prompt = buildGraderPrompt(RUBRIC, "some artifact");
    expect(prompt).toContain("mentions_base_case");
    expect(prompt).toContain("mentions_self_reference");
  });

  test("full rubric prompt includes rubric description", () => {
    const prompt = buildGraderPrompt(RUBRIC, "some artifact");
    expect(prompt).toContain("Explain recursion clearly");
  });

  test("full rubric prompt includes the artifact", () => {
    const artifact = "Recursion is when a function calls itself.";
    const prompt = buildGraderPrompt(RUBRIC, artifact);
    expect(prompt).toContain(artifact);
  });

  test("single-criterion prompt includes only that criterion name", () => {
    const criterion = RUBRIC.criteria[0];
    if (criterion === undefined) throw new Error("RUBRIC.criteria[0] must be defined");
    const prompt = buildGraderPrompt(RUBRIC, "artifact", criterion);
    expect(prompt).toContain("mentions_base_case");
    expect(prompt).not.toContain("mentions_self_reference");
  });

  test("single-criterion prompt still includes rubric description", () => {
    const criterion = RUBRIC.criteria[0];
    if (criterion === undefined) throw new Error("RUBRIC.criteria[0] must be defined");
    const prompt = buildGraderPrompt(RUBRIC, "artifact", criterion);
    expect(prompt).toContain("Explain recursion clearly");
  });

  test("prompt instructs grader to respond with valid JSON only", () => {
    const prompt = buildGraderPrompt(RUBRIC, "artifact");
    expect(prompt).toContain("valid JSON");
    expect(prompt).toContain('"passed"');
    expect(prompt).toContain('"criteria"');
  });

  test("artifact containing special JSON characters does not break prompt structure", () => {
    const artifact = 'Output: {"key": "value", "arr": [1, 2, 3]}';
    const prompt = buildGraderPrompt(RUBRIC, artifact);
    // Artifact is wrapped in XML-style tags, not embedded in JSON
    expect(prompt).toContain("<artifact>");
    expect(prompt).toContain("</artifact>");
    expect(prompt).toContain(artifact);
  });

  test("prompt includes criterion descriptions", () => {
    const prompt = buildGraderPrompt(RUBRIC, "artifact");
    expect(prompt).toContain("Mentions a base case");
    expect(prompt).toContain("Mentions that a function calls itself");
  });
});

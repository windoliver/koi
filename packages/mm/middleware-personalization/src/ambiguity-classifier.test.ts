import { describe, expect, test } from "bun:test";
import type { MemoryResult } from "@koi/core/ecs";
import { createDefaultAmbiguityClassifier } from "./ambiguity-classifier.js";

describe("createDefaultAmbiguityClassifier", () => {
  const classifier = createDefaultAmbiguityClassifier();

  test("returns ambiguous when question AND alternative markers present", async () => {
    const result = await classifier.classify("should I use dark mode or light mode?", []);
    expect(result).toEqual({
      ambiguous: true,
      suggestedDirective: expect.any(String),
    });
  });

  test("returns not ambiguous for question marker alone", async () => {
    const result = await classifier.classify("should I deploy?", []);
    expect(result.ambiguous).toBe(false);
  });

  test("returns not ambiguous for alternative marker alone", async () => {
    const result = await classifier.classify("dark mode or light mode?", []);
    expect(result.ambiguous).toBe(false);
  });

  test("returns not ambiguous for vague qualifiers (removed)", async () => {
    const result = await classifier.classify("pick some nice colors", []);
    expect(result.ambiguous).toBe(false);
  });

  test("returns not ambiguous when preferences exist", async () => {
    const prefs: readonly MemoryResult[] = [{ content: "User prefers dark mode", score: 0.9 }];
    const result = await classifier.classify("should I use dark mode or light mode?", prefs);
    expect(result.ambiguous).toBe(false);
  });

  test("returns not ambiguous for clear instructions", async () => {
    const result = await classifier.classify("deploy to production", []);
    expect(result.ambiguous).toBe(false);
  });

  test("returns not ambiguous for empty string", async () => {
    const result = await classifier.classify("", []);
    expect(result.ambiguous).toBe(false);
  });

  test("handles very long input without crashing", async () => {
    const longInput = `should I use ${" or ".repeat(10_000)}`;
    const result = await classifier.classify(longInput, []);
    expect(result.ambiguous).toBe(true);
  });

  test("detects 'how should' + alternative", async () => {
    const result = await classifier.classify("how should I format the dates — ISO or locale?", []);
    expect(result.ambiguous).toBe(true);
  });

  test("detects 'what kind' + alternative", async () => {
    const result = await classifier.classify("what kind of output do you prefer?", []);
    expect(result.ambiguous).toBe(true);
  });

  test("detects 'which' + 'between'", async () => {
    const result = await classifier.classify("which option between tabs and spaces?", []);
    expect(result.ambiguous).toBe(true);
  });

  test("detects 'should I' + 'either'", async () => {
    const result = await classifier.classify("should I use either TypeScript or JavaScript?", []);
    expect(result.ambiguous).toBe(true);
  });

  test("suggested directive is actionable", async () => {
    const result = await classifier.classify("which framework should I prefer?", []);
    expect(result.suggestedDirective).toContain("ask the user");
  });

  test("good morning is not ambiguous", async () => {
    const result = await classifier.classify("good morning", []);
    expect(result.ambiguous).toBe(false);
  });
});

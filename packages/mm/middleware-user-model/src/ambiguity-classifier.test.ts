import { describe, expect, test } from "bun:test";
import type { MemoryResult } from "@koi/core/ecs";
import { createDefaultAmbiguityClassifier } from "./ambiguity-classifier.js";

describe("createDefaultAmbiguityClassifier", () => {
  const classifier = createDefaultAmbiguityClassifier();

  test("detects ambiguity with question + alternative markers", () => {
    const result = classifier.classify("Which format should I use or do you prefer another?", []);
    expect(result.ambiguous).toBe(true);
    expect(result.suggestedDirective).toBeDefined();
  });

  test("not ambiguous with only question marker", () => {
    const result = classifier.classify("Which format should I use?", []);
    expect(result.ambiguous).toBe(false);
  });

  test("not ambiguous with only alternative marker", () => {
    const result = classifier.classify("I can use tabs or spaces", []);
    expect(result.ambiguous).toBe(false);
  });

  test("not ambiguous when relevant preferences exist", () => {
    const prefs: readonly MemoryResult[] = [{ content: "Use tabs", score: 0.9 }];
    const result = classifier.classify(
      "Which format should I use or do you prefer another?",
      prefs,
    );
    expect(result.ambiguous).toBe(false);
  });

  test("not ambiguous for empty instruction", () => {
    const result = classifier.classify("", []);
    expect(result.ambiguous).toBe(false);
  });

  test("not ambiguous for normal instruction", () => {
    const result = classifier.classify("Please format my code", []);
    expect(result.ambiguous).toBe(false);
  });
});

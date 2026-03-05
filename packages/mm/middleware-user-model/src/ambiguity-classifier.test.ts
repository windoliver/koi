import { describe, expect, test } from "bun:test";
import type { MemoryResult } from "@koi/core/ecs";
import { createDefaultAmbiguityClassifier } from "./ambiguity-classifier.js";

describe("createDefaultAmbiguityClassifier", () => {
  const classifier = createDefaultAmbiguityClassifier();

  test("detects ambiguity with question + alternative markers", async () => {
    const result = await classifier.classify(
      "Which format should I use or do you prefer another?",
      [],
    );
    expect(result.ambiguous).toBe(true);
    expect(result.suggestedDirective).toBeDefined();
  });

  test("not ambiguous with only question marker", async () => {
    const result = await classifier.classify("Which format should I use?", []);
    expect(result.ambiguous).toBe(false);
  });

  test("not ambiguous with only alternative marker", async () => {
    const result = await classifier.classify("I can use tabs or spaces", []);
    expect(result.ambiguous).toBe(false);
  });

  test("not ambiguous when relevant preferences exist", async () => {
    const prefs: readonly MemoryResult[] = [{ content: "Use tabs", score: 0.9 }];
    const result = await classifier.classify(
      "Which format should I use or do you prefer another?",
      prefs,
    );
    expect(result.ambiguous).toBe(false);
  });

  test("not ambiguous for empty instruction", async () => {
    const result = await classifier.classify("", []);
    expect(result.ambiguous).toBe(false);
  });

  test("not ambiguous for normal instruction", async () => {
    const result = await classifier.classify("Please format my code", []);
    expect(result.ambiguous).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";
import { generateCompositeImplementation } from "./generate-composite.js";
import type { CrystallizationCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCandidate(
  toolIds: readonly string[],
  occurrences: number,
): CrystallizationCandidate {
  const key = toolIds.join("|");
  return {
    ngram: { steps: toolIds.map((id) => ({ toolId: id })), key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt: 1000,
    suggestedName: toolIds.join("-then-"),
  };
}

// ---------------------------------------------------------------------------
// generateCompositeImplementation
// ---------------------------------------------------------------------------

describe("generateCompositeImplementation", () => {
  test("generates implementation with pipeline executor import", () => {
    const candidate = createCandidate(["fetch", "parse", "save"], 5);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("export default async function execute");
    expect(impl).toContain("executePipeline");
    expect(impl).toContain('"fetch"');
    expect(impl).toContain('"parse"');
    expect(impl).toContain('"save"');
  });

  test("includes step definitions as const array", () => {
    const candidate = createCandidate(["fetch", "parse"], 3);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("as const");
    expect(impl).toContain("STEPS");
  });

  test("uses executePipeline for execution", () => {
    const candidate = createCandidate(["fetch", "parse", "save"], 3);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("executePipeline(STEPS, ctx");
    expect(impl).toContain("result.value");
  });

  test("handles errors from pipeline", () => {
    const candidate = createCandidate(["a", "b", "c"], 3);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("!result.ok");
    expect(impl).toContain("throw new Error");
  });

  test("includes pattern comment with arrow notation", () => {
    const candidate = createCandidate(["fetch", "parse"], 4);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("fetch \u2192 parse");
    expect(impl).toContain("4 occurrences");
  });

  test("includes auto-generated comment", () => {
    const candidate = createCandidate(["a", "b"], 2);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("Auto-generated composite tool");
    expect(impl).toContain("pipeline executor");
  });

  test("handles single-step candidate", () => {
    const candidate = createCandidate(["only"], 5);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain('"only"');
    expect(impl).toContain("executePipeline");
  });
});

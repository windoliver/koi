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
  test("generates implementation with sequential tool calls", () => {
    const candidate = createCandidate(["fetch", "parse", "save"], 5);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("export default async function execute");
    expect(impl).toContain('ctx.executor("fetch"');
    expect(impl).toContain('ctx.executor("parse"');
    expect(impl).toContain('ctx.executor("save"');
  });

  test("first step receives undefined as input", () => {
    const candidate = createCandidate(["fetch", "parse"], 3);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain('ctx.executor("fetch", undefined)');
  });

  test("subsequent steps receive previous result", () => {
    const candidate = createCandidate(["fetch", "parse", "save"], 3);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain('ctx.executor("parse", result_0)');
    expect(impl).toContain('ctx.executor("save", result_1)');
  });

  test("returns last result variable", () => {
    const candidate = createCandidate(["a", "b", "c"], 3);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("return result_2;");
  });

  test("includes pattern comment with arrow notation", () => {
    const candidate = createCandidate(["fetch", "parse"], 4);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("fetch \u2192 parse");
    expect(impl).toContain("4 occurrences");
  });

  test("includes auto-generated and deferred comments", () => {
    const candidate = createCandidate(["a", "b"], 2);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain("Auto-generated composite tool");
    expect(impl).toContain("Parameters deferred");
  });

  test("handles single-step candidate", () => {
    const candidate = createCandidate(["only"], 5);
    const impl = generateCompositeImplementation(candidate);

    expect(impl).toContain('ctx.executor("only", undefined)');
    expect(impl).toContain("return result_0;");
  });
});

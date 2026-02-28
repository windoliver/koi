import { describe, expect, mock, test } from "bun:test";
import type { CrystallizedToolDescriptor } from "./forge-handler.js";
import { createCrystallizeForgeHandler } from "./forge-handler.js";
import type { CrystallizationCandidate } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCandidate(
  toolIds: readonly string[],
  occurrences: number,
  detectedAt: number,
  score?: number,
): CrystallizationCandidate {
  const key = toolIds.join("|");
  const base = {
    ngram: { steps: toolIds.map((id) => ({ toolId: id })), key },
    occurrences,
    turnIndices: Array.from({ length: occurrences }, (_, i) => i),
    detectedAt,
    suggestedName: toolIds.join("-then-"),
  };
  if (score !== undefined) {
    return { ...base, score };
  }
  return base;
}

// ---------------------------------------------------------------------------
// createCrystallizeForgeHandler
// ---------------------------------------------------------------------------

describe("createCrystallizeForgeHandler", () => {
  test("forges candidate with confidence at or above threshold", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      confidenceThreshold: 0.9,
    });

    // Fresh candidate (detectedAt = now) => recency = 1.0 => confidence = 1.0
    const candidate = createCandidate(["fetch", "parse"], 5, 1000);
    const result = handler.handleCandidates([candidate], 1000);

    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("fetch-then-parse");
    expect(result[0]?.scope).toBe("agent");
    expect(result[0]?.trustTier).toBe("sandbox");
  });

  test("does not forge candidate below confidence threshold", () => {
    const onSuggested = mock((_: CrystallizationCandidate) => {});
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      confidenceThreshold: 0.9,
      onSuggested,
    });

    // Old candidate (far in the past) => low recency => low confidence
    const candidate = createCandidate(["fetch", "parse"], 5, 0);
    const result = handler.handleCandidates([candidate], 100_000_000);

    expect(result).toHaveLength(0);
    expect(onSuggested).toHaveBeenCalledTimes(1);
  });

  test("respects maxForgedPerSession", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      confidenceThreshold: 0.0, // forge everything
      maxForgedPerSession: 2,
    });

    const candidates = [
      createCandidate(["a", "b"], 5, 1000),
      createCandidate(["c", "d"], 5, 1000),
      createCandidate(["e", "f"], 5, 1000),
    ];

    const result = handler.handleCandidates(candidates, 1000);
    expect(result).toHaveLength(2);
    expect(handler.getForgedCount()).toBe(2);
  });

  test("does not re-forge same suggested name", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      confidenceThreshold: 0.0,
      maxForgedPerSession: 10,
    });

    const candidate = createCandidate(["fetch", "parse"], 5, 1000);
    handler.handleCandidates([candidate], 1000);
    // Same candidate again
    const result2 = handler.handleCandidates([candidate], 1000);

    expect(result2).toHaveLength(0);
    expect(handler.getForgedCount()).toBe(1);
  });

  test("calls onForged callback for each forged descriptor", () => {
    const onForged = mock((_: CrystallizedToolDescriptor) => {});
    const handler = createCrystallizeForgeHandler({
      scope: "zone",
      confidenceThreshold: 0.0,
      onForged,
    });

    const candidate = createCandidate(["fetch", "parse"], 5, 1000);
    handler.handleCandidates([candidate], 1000);

    expect(onForged).toHaveBeenCalledTimes(1);
    const forged = onForged.mock.calls[0]?.[0];
    expect(forged?.provenance.source).toBe("crystallize");
    expect(forged?.provenance.ngramKey).toBe("fetch|parse");
  });

  test("uses custom trustTier", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      trustTier: "verified",
      confidenceThreshold: 0.0,
    });

    const candidate = createCandidate(["a", "b"], 5, 1000);
    const result = handler.handleCandidates([candidate], 1000);

    expect(result[0]?.trustTier).toBe("verified");
  });

  test("forged descriptor includes implementation", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      confidenceThreshold: 0.0,
    });

    const candidate = createCandidate(["fetch", "parse"], 5, 1000);
    const result = handler.handleCandidates([candidate], 1000);

    expect(result[0]?.implementation).toContain('ctx.executor("fetch"');
    expect(result[0]?.implementation).toContain('ctx.executor("parse"');
  });

  test("returns empty when maxForged already reached from prior calls", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      confidenceThreshold: 0.0,
      maxForgedPerSession: 1,
    });

    const first = createCandidate(["a", "b"], 5, 1000);
    handler.handleCandidates([first], 1000);
    expect(handler.getForgedCount()).toBe(1);

    const second = createCandidate(["c", "d"], 5, 1000);
    const result = handler.handleCandidates([second], 1000);
    expect(result).toHaveLength(0);
  });

  test("uses pre-computed score from candidate when available", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      confidenceThreshold: 0.0,
    });

    // Provide pre-computed score
    const candidate = createCandidate(["fetch", "parse"], 5, 1000, 42);
    const result = handler.handleCandidates([candidate], 1000);

    expect(result[0]?.provenance.score).toBe(42);
  });

  test("forged descriptor has correct description", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
      confidenceThreshold: 0.0,
    });

    const candidate = createCandidate(["fetch", "parse"], 5, 1000);
    const result = handler.handleCandidates([candidate], 1000);

    expect(result[0]?.description).toContain("Auto-crystallized composite");
    expect(result[0]?.description).toContain("fetch");
    expect(result[0]?.description).toContain("parse");
  });

  test("getForgedCount starts at zero", () => {
    const handler = createCrystallizeForgeHandler({
      scope: "agent",
    });
    expect(handler.getForgedCount()).toBe(0);
  });
});

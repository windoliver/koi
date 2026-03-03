import { describe, expect, it } from "bun:test";
import type { UsagePurposeObservation } from "@koi/core";
import { detectPurposeDrift } from "./heuristics.js";
import type { ExaptationThresholds } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS: ExaptationThresholds = {
  minObservations: 5,
  divergenceThreshold: 0.7,
  minDivergentAgents: 2,
  confidenceWeight: 0.8,
} as const;

function createObservation(overrides?: Partial<UsagePurposeObservation>): UsagePurposeObservation {
  return {
    contextText: "some context",
    agentId: "agent-1",
    divergenceScore: 0.8,
    observedAt: Date.now(),
    ...overrides,
  };
}

function createDivergentObservations(
  count: number,
  agentIds: readonly string[],
): readonly UsagePurposeObservation[] {
  return Array.from({ length: count }, (_, i) =>
    createObservation({
      agentId: agentIds[i % agentIds.length] ?? "agent-default",
      divergenceScore: 0.85,
      observedAt: Date.now() + i,
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("detectPurposeDrift", () => {
  it("returns undefined when below minObservations", () => {
    const observations = createDivergentObservations(4, ["agent-1", "agent-2"]);
    expect(detectPurposeDrift(observations, DEFAULT_THRESHOLDS)).toBeUndefined();
  });

  it("returns undefined when average divergence is below threshold", () => {
    const observations = Array.from({ length: 6 }, (_, i) =>
      createObservation({
        agentId: i < 3 ? "agent-1" : "agent-2",
        divergenceScore: 0.3, // well below 0.7 threshold
      }),
    );
    expect(detectPurposeDrift(observations, DEFAULT_THRESHOLDS)).toBeUndefined();
  });

  it("returns undefined when below minDivergentAgents", () => {
    // All from a single agent — fails minDivergentAgents=2
    const observations = createDivergentObservations(6, ["agent-1"]);
    expect(detectPurposeDrift(observations, DEFAULT_THRESHOLDS)).toBeUndefined();
  });

  it("returns 'purpose_drift' when all criteria met", () => {
    const observations = createDivergentObservations(6, ["agent-1", "agent-2"]);
    expect(detectPurposeDrift(observations, DEFAULT_THRESHOLDS)).toBe("purpose_drift");
  });

  it("returns undefined for single agent even with high divergence", () => {
    const observations = createDivergentObservations(10, ["agent-1"]);
    expect(
      detectPurposeDrift(observations, { ...DEFAULT_THRESHOLDS, minDivergentAgents: 2 }),
    ).toBeUndefined();
  });

  it("triggers at exact threshold boundary", () => {
    // Exactly at minObservations=5, divergence=0.7, 2 agents
    const observations = Array.from({ length: 5 }, (_, i) =>
      createObservation({
        agentId: i < 3 ? "agent-1" : "agent-2",
        divergenceScore: 0.7,
      }),
    );
    expect(detectPurposeDrift(observations, DEFAULT_THRESHOLDS)).toBe("purpose_drift");
  });

  it("returns undefined for empty observations", () => {
    expect(detectPurposeDrift([], DEFAULT_THRESHOLDS)).toBeUndefined();
  });

  it("counts only divergent agents (above threshold) for minDivergentAgents", () => {
    // 2 agents, but only one has divergence above threshold
    const observations = [
      ...Array.from({ length: 4 }, () =>
        createObservation({ agentId: "agent-1", divergenceScore: 0.9 }),
      ),
      ...Array.from({ length: 3 }, () =>
        createObservation({ agentId: "agent-2", divergenceScore: 0.5 }),
      ),
    ];
    // Average divergence: (4*0.9 + 3*0.5)/7 ≈ 0.729 — above 0.7
    // But agent-2's observations are below 0.7, so only 1 divergent agent
    expect(detectPurposeDrift(observations, DEFAULT_THRESHOLDS)).toBeUndefined();
  });
});

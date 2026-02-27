import { describe, expect, test } from "bun:test";
import type { BrickArtifactBase, BrickFitnessMetrics, ForgeQuery } from "@koi/core";
import { sortBricks } from "./sort-bricks.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = 1_700_000_000_000;
const MS_PER_DAY = 86_400_000;

function createBrick(name: string, overrides?: Partial<BrickArtifactBase>): BrickArtifactBase {
  return {
    id: `sha256:${"a".repeat(64)}` as BrickArtifactBase["id"],
    kind: "tool",
    name,
    description: `Brick ${name}`,
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    provenance: {
      buildDefinition: { buildType: "forge/v1", externalParameters: {}, internalParameters: {} },
      runDetails: {
        builder: { id: "agent-1", version: "0.0.1" },
        metadata: { agentId: "agent-1", sessionId: "s1", invocationId: "inv1", depth: 0 },
        byProducts: [],
      },
      classification: "internal",
      contentMarkers: [],
    },
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    ...overrides,
  } as BrickArtifactBase;
}

function createFitness(overrides?: Partial<BrickFitnessMetrics>): BrickFitnessMetrics {
  return {
    successCount: 10,
    errorCount: 0,
    latency: { samples: [50], count: 1, cap: 200 },
    lastUsedAt: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Basic sorting
// ---------------------------------------------------------------------------

describe("sortBricks", () => {
  test("returns empty array for empty input", () => {
    const result = sortBricks([], {}, { nowMs: NOW });
    expect(result).toEqual([]);
  });

  test("returns single brick unchanged", () => {
    const brick = createBrick("alpha");
    const result = sortBricks([brick], {}, { nowMs: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("alpha");
  });

  test("does not mutate original array", () => {
    const bricks = [
      createBrick("beta", { fitness: createFitness({ successCount: 5 }) }),
      createBrick("alpha", { fitness: createFitness({ successCount: 10 }) }),
    ];
    const originalNames = bricks.map((b) => b.name);
    sortBricks(bricks, {}, { nowMs: NOW });
    expect(bricks.map((b) => b.name)).toEqual(originalNames);
  });

  // ---------------------------------------------------------------------------
  // orderBy: "fitness" (default)
  // ---------------------------------------------------------------------------

  test("default orderBy sorts by fitness descending", () => {
    const bricks = [
      createBrick("low", {
        fitness: createFitness({ successCount: 1, errorCount: 9 }),
        usageCount: 1,
      }),
      createBrick("high", {
        fitness: createFitness({ successCount: 50, errorCount: 0 }),
        usageCount: 50,
      }),
      createBrick("mid", {
        fitness: createFitness({ successCount: 10, errorCount: 5 }),
        usageCount: 10,
      }),
    ];
    const result = sortBricks(bricks, {}, { nowMs: NOW });
    expect(result[0]?.name).toBe("high");
    expect(result[2]?.name).toBe("low");
  });

  test("bricks without fitness are scored as 0", () => {
    const bricks = [
      createBrick("unused"),
      createBrick("used", { fitness: createFitness(), usageCount: 10 }),
    ];
    const result = sortBricks(bricks, {}, { nowMs: NOW });
    expect(result[0]?.name).toBe("used");
    expect(result[1]?.name).toBe("unused");
  });

  // ---------------------------------------------------------------------------
  // orderBy: "recency"
  // ---------------------------------------------------------------------------

  test("orderBy recency sorts by lastUsedAt descending", () => {
    const bricks = [
      createBrick("old", { fitness: createFitness({ lastUsedAt: NOW - 30 * MS_PER_DAY }) }),
      createBrick("new", { fitness: createFitness({ lastUsedAt: NOW }) }),
      createBrick("mid", { fitness: createFitness({ lastUsedAt: NOW - 10 * MS_PER_DAY }) }),
    ];
    const query: ForgeQuery = { orderBy: "recency" };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    expect(result[0]?.name).toBe("new");
    expect(result[1]?.name).toBe("mid");
    expect(result[2]?.name).toBe("old");
  });

  // ---------------------------------------------------------------------------
  // orderBy: "usage"
  // ---------------------------------------------------------------------------

  test("orderBy usage sorts by usageCount descending", () => {
    const bricks = [
      createBrick("few", { usageCount: 2 }),
      createBrick("many", { usageCount: 100 }),
      createBrick("some", { usageCount: 20 }),
    ];
    const query: ForgeQuery = { orderBy: "usage" };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    expect(result[0]?.name).toBe("many");
    expect(result[1]?.name).toBe("some");
    expect(result[2]?.name).toBe("few");
  });

  // ---------------------------------------------------------------------------
  // Tiebreak
  // ---------------------------------------------------------------------------

  test("tiebreak sorts alphabetically by name", () => {
    const fitness = createFitness({ successCount: 10, errorCount: 0 });
    const bricks = [
      createBrick("charlie", { fitness, usageCount: 10 }),
      createBrick("alpha", { fitness, usageCount: 10 }),
      createBrick("bravo", { fitness, usageCount: 10 }),
    ];
    const result = sortBricks(bricks, {}, { nowMs: NOW });
    expect(result[0]?.name).toBe("alpha");
    expect(result[1]?.name).toBe("bravo");
    expect(result[2]?.name).toBe("charlie");
  });

  // ---------------------------------------------------------------------------
  // minFitnessScore filtering
  // ---------------------------------------------------------------------------

  test("minFitnessScore filters out low-scoring bricks", () => {
    const bricks = [
      createBrick("good", {
        fitness: createFitness({ successCount: 50, errorCount: 0 }),
        usageCount: 50,
      }),
      createBrick("unused"),
    ];
    const query: ForgeQuery = { minFitnessScore: 0.01 };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("good");
  });

  test("minFitnessScore of 0 keeps all bricks", () => {
    const bricks = [createBrick("a"), createBrick("b", { fitness: createFitness() })];
    const query: ForgeQuery = { minFitnessScore: 0 };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    expect(result).toHaveLength(2);
  });

  test("minFitnessScore of 1 filters very aggressively", () => {
    const bricks = [
      createBrick("a", {
        fitness: createFitness({ successCount: 10, errorCount: 0 }),
        usageCount: 10,
      }),
    ];
    const query: ForgeQuery = { minFitnessScore: 1.0 };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    // usageNorm < 1 so score < 1, should be filtered
    expect(result).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Custom fitness config passthrough
  // ---------------------------------------------------------------------------

  test("passes fitnessConfig through to scoring", () => {
    const bricks = [
      createBrick("a", {
        fitness: createFitness({
          successCount: 5,
          errorCount: 5,
          lastUsedAt: NOW,
        }),
        usageCount: 10,
      }),
    ];
    // With exponent 1 vs 2, scores will differ
    const score1 = sortBricks(bricks, {}, { nowMs: NOW, fitnessConfig: { successExponent: 1.0 } });
    const score2 = sortBricks(bricks, {}, { nowMs: NOW, fitnessConfig: { successExponent: 3.0 } });
    // Both should return the single brick (no minFitnessScore filter)
    expect(score1).toHaveLength(1);
    expect(score2).toHaveLength(1);
  });
});

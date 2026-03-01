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

  // ---------------------------------------------------------------------------
  // orderBy: "trailStrength"
  // ---------------------------------------------------------------------------

  test("orderBy trailStrength sorts by effective trail strength descending", () => {
    const bricks = [
      createBrick("weak", { trailStrength: 0.1, fitness: createFitness() }),
      createBrick("strong", { trailStrength: 0.9, fitness: createFitness() }),
      createBrick("mid", { trailStrength: 0.5, fitness: createFitness() }),
    ];
    const query: ForgeQuery = { orderBy: "trailStrength" };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    expect(result[0]?.name).toBe("strong");
    expect(result[1]?.name).toBe("mid");
    expect(result[2]?.name).toBe("weak");
  });

  test("trailStrength uses DEFAULT_TRAIL_STRENGTH when undefined", () => {
    const bricks = [
      createBrick("explicit", { trailStrength: 0.3, fitness: createFitness() }),
      createBrick("default", { fitness: createFitness() }), // trailStrength undefined → 0.5
    ];
    const query: ForgeQuery = { orderBy: "trailStrength" };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    // default (0.5) > explicit (0.3)
    expect(result[0]?.name).toBe("default");
    expect(result[1]?.name).toBe("explicit");
  });

  test("trailStrength decays based on elapsed time from lastUsedAt", () => {
    // Two bricks with same stored trail strength but different recency
    const bricks = [
      createBrick("stale", {
        trailStrength: 0.8,
        fitness: createFitness({ lastUsedAt: NOW - 30 * MS_PER_DAY }),
      }),
      createBrick("fresh", {
        trailStrength: 0.8,
        fitness: createFitness({ lastUsedAt: NOW }),
      }),
    ];
    const query: ForgeQuery = { orderBy: "trailStrength" };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    // Fresh brick has higher effective trail strength (no decay)
    expect(result[0]?.name).toBe("fresh");
    expect(result[1]?.name).toBe("stale");
  });

  test("trailStrength tiebreak sorts alphabetically by name", () => {
    const bricks = [
      createBrick("charlie", { trailStrength: 0.5, fitness: createFitness() }),
      createBrick("alpha", { trailStrength: 0.5, fitness: createFitness() }),
      createBrick("bravo", { trailStrength: 0.5, fitness: createFitness() }),
    ];
    const query: ForgeQuery = { orderBy: "trailStrength" };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    expect(result[0]?.name).toBe("alpha");
    expect(result[1]?.name).toBe("bravo");
    expect(result[2]?.name).toBe("charlie");
  });

  // ---------------------------------------------------------------------------
  // minTrailStrength filtering
  // ---------------------------------------------------------------------------

  test("minTrailStrength filters out bricks below threshold", () => {
    const bricks = [
      createBrick("strong", { trailStrength: 0.8, fitness: createFitness() }),
      createBrick("weak", { trailStrength: 0.1, fitness: createFitness() }),
    ];
    const query: ForgeQuery = { minTrailStrength: 0.5 };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("strong");
  });

  test("minTrailStrength of 0 keeps all bricks", () => {
    const bricks = [
      createBrick("a", { trailStrength: 0.1, fitness: createFitness() }),
      createBrick("b", { trailStrength: 0.9, fitness: createFitness() }),
    ];
    const query: ForgeQuery = { minTrailStrength: 0 };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    expect(result).toHaveLength(2);
  });

  test("minTrailStrength accounts for decay when filtering", () => {
    // Brick has high stored trail but is very stale → effective is low
    const bricks = [
      createBrick("stale-high", {
        trailStrength: 0.8,
        fitness: createFitness({ lastUsedAt: NOW - 60 * MS_PER_DAY }),
      }),
      createBrick("fresh-low", {
        trailStrength: 0.3,
        fitness: createFitness({ lastUsedAt: NOW }),
      }),
    ];
    const query: ForgeQuery = { minTrailStrength: 0.2 };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    // fresh-low (0.3, no decay) stays; stale-high should decay below 0.2 after 60 days
    expect(result.some((b) => b.name === "fresh-low")).toBe(true);
  });

  test("combined minFitnessScore and minTrailStrength filtering", () => {
    const bricks = [
      createBrick("both-good", {
        trailStrength: 0.8,
        fitness: createFitness({ successCount: 50, errorCount: 0 }),
        usageCount: 50,
      }),
      createBrick("good-fitness-bad-trail", {
        trailStrength: 0.05,
        fitness: createFitness({ successCount: 50, errorCount: 0 }),
        usageCount: 50,
      }),
      createBrick("bad-fitness-good-trail", {
        trailStrength: 0.8,
        usageCount: 0,
      }),
    ];
    const query: ForgeQuery = { minFitnessScore: 0.01, minTrailStrength: 0.1 };
    const result = sortBricks(bricks, query, { nowMs: NOW });
    // Only "both-good" passes both filters
    expect(result).toHaveLength(1);
    expect(result[0]?.name).toBe("both-good");
  });

  test("trailConfig option is passed through for decay computation", () => {
    // With very short half-life, stale brick decays more aggressively
    const bricks = [
      createBrick("stale", {
        trailStrength: 0.9,
        fitness: createFitness({ lastUsedAt: NOW - 2 * MS_PER_DAY }),
      }),
      createBrick("fresh", {
        trailStrength: 0.5,
        fitness: createFitness({ lastUsedAt: NOW }),
      }),
    ];
    const query: ForgeQuery = { orderBy: "trailStrength" };
    // With very short half-life (0.5 days), the stale brick decays significantly
    const result = sortBricks(bricks, query, {
      nowMs: NOW,
      trailConfig: { halfLifeDays: 0.5 },
    });
    // After 2 days with 0.5 day half-life → 4 half-lives → 0.9 * (1/16) ≈ 0.056
    // Fresh is 0.5, so fresh should rank higher
    expect(result[0]?.name).toBe("fresh");
    expect(result[1]?.name).toBe("stale");
  });
});

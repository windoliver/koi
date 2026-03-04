/**
 * Unit tests for createCatalogAgentResolver.
 */

import { describe, expect, it, mock } from "bun:test";
import type { BrickArtifact, BrickFitnessMetrics, ForgeStore, KoiError, Result } from "@koi/core";
import { brickId } from "@koi/core";
import { createTestAgentArtifact } from "@koi/test-utils";

import { createCatalogAgentResolver } from "./agent-resolver.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_MANIFEST_YAML = `name: "test-agent"\nversion: "0.0.1"\nmodel: "mock-model"`;

const INVALID_MANIFEST_YAML = "not: valid: yaml: {{";

function createMockForgeStore(
  searchResult: Result<readonly BrickArtifact[], KoiError>,
): ForgeStore {
  return {
    save: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    load: mock(
      async () =>
        ({ ok: false, error: { code: "NOT_FOUND", message: "n/a", retryable: false } }) as Result<
          BrickArtifact,
          KoiError
        >,
    ),
    search: mock(async () => searchResult),
    remove: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    update: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    exists: mock(async () => ({ ok: true, value: false }) as Result<boolean, KoiError>),
  };
}

function agentBrick(
  overrides: Partial<BrickArtifact> & { readonly manifestYaml?: string } = {},
): BrickArtifact {
  return createTestAgentArtifact({
    manifestYaml: VALID_MANIFEST_YAML,
    tags: ["research"],
    ...overrides,
  });
}

function fitnessMetrics(
  successCount: number,
  errorCount: number,
  lastUsedAt: number,
): BrickFitnessMetrics {
  return {
    successCount,
    errorCount,
    latency: { samples: [100], count: 1, cap: 200 },
    lastUsedAt,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createCatalogAgentResolver", () => {
  describe("resolve", () => {
    it("returns TaskableAgent for single matching brick", async () => {
      const brick = agentBrick({ name: "researcher", description: "Research agent" });
      const store = createMockForgeStore({ ok: true, value: [brick] });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const result = await resolver.resolve("research");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("researcher");
        expect(result.value.description).toBe("Research agent");
        expect(result.value.manifest.name).toBe("test-agent");
        expect(result.value.brickId).toBe(brick.id);
      }
    });

    it("selects highest fitness brick from multiple candidates", async () => {
      const now = 1_000_000;
      const highFitness = agentBrick({
        id: brickId("brick_high"),
        name: "high-fit",
        fitness: fitnessMetrics(100, 0, now),
      });
      const lowFitness = agentBrick({
        id: brickId("brick_low"),
        name: "low-fit",
        fitness: fitnessMetrics(1, 50, now - 86_400_000 * 60),
      });
      const store = createMockForgeStore({ ok: true, value: [lowFitness, highFitness] });

      // Use random=0.99 to pick near the end of the cumulative distribution.
      // High-fitness brick dominates the weight, so 0.99 * totalWeight still
      // falls within the high-fitness segment.
      const resolver = createCatalogAgentResolver({
        forgeStore: store,
        random: () => 0.99,
        clock: () => now,
        degeneracyConfig: { explorationRate: 0, minExploration: 0, maxExploration: 0 },
      });

      const result = await resolver.resolve("research");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("high-fit");
        expect(result.value.brickId).toBe(brickId("brick_high"));
      }
    });

    it("returns NOT_FOUND when no bricks match", async () => {
      const store = createMockForgeStore({ ok: true, value: [] });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const result = await resolver.resolve("nonexistent");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("NOT_FOUND");
        expect(result.error.message).toContain("nonexistent");
      }
    });

    it("returns EXTERNAL error when store search fails", async () => {
      const store = createMockForgeStore({
        ok: false,
        error: { code: "EXTERNAL", message: "connection refused", retryable: true },
      });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const result = await resolver.resolve("research");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("EXTERNAL");
        expect(result.error.message).toContain("connection refused");
      }
    });

    it("skips brick with invalid manifest and tries next", async () => {
      const broken = agentBrick({
        id: brickId("brick_broken"),
        name: "broken-agent",
        manifestYaml: INVALID_MANIFEST_YAML,
        fitness: fitnessMetrics(100, 0, Date.now()),
      });
      const valid = agentBrick({
        id: brickId("brick_valid"),
        name: "valid-agent",
        manifestYaml: VALID_MANIFEST_YAML,
        fitness: fitnessMetrics(1, 0, Date.now()),
      });
      const store = createMockForgeStore({ ok: true, value: [broken, valid] });

      const resolver = createCatalogAgentResolver({
        forgeStore: store,
        random: () => 0,
        degeneracyConfig: { explorationRate: 0, minExploration: 0, maxExploration: 0 },
      });

      const result = await resolver.resolve("research");

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe("valid-agent");
      }
    });

    it("returns VALIDATION error when all manifests are invalid", async () => {
      const broken1 = agentBrick({ id: brickId("brick_b1"), manifestYaml: INVALID_MANIFEST_YAML });
      const broken2 = agentBrick({ id: brickId("brick_b2"), manifestYaml: INVALID_MANIFEST_YAML });
      const store = createMockForgeStore({ ok: true, value: [broken1, broken2] });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const result = await resolver.resolve("research");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("invalid manifests");
      }
    });

    it("returns VALIDATION error for single brick with invalid manifest", async () => {
      const broken = agentBrick({ manifestYaml: INVALID_MANIFEST_YAML });
      const store = createMockForgeStore({ ok: true, value: [broken] });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const result = await resolver.resolve("research");

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe("VALIDATION");
        expect(result.error.message).toContain("Failed to parse manifest");
      }
    });

    it("caches search results within TTL", async () => {
      const brick = agentBrick();
      const store = createMockForgeStore({ ok: true, value: [brick] });
      // eslint-disable-next-line no-restricted-syntax -- justified: mutable for clock simulation
      let now = 1_000_000;
      const resolver = createCatalogAgentResolver({
        forgeStore: store,
        clock: () => now,
        cacheTtlMs: 5_000,
      });

      await resolver.resolve("research");
      now += 3_000; // within TTL
      await resolver.resolve("research");

      expect(store.search).toHaveBeenCalledTimes(1);
    });

    it("refreshes cache after TTL expires", async () => {
      const brick = agentBrick();
      const store = createMockForgeStore({ ok: true, value: [brick] });
      // eslint-disable-next-line no-restricted-syntax -- justified: mutable for clock simulation
      let now = 1_000_000;
      const resolver = createCatalogAgentResolver({
        forgeStore: store,
        clock: () => now,
        cacheTtlMs: 5_000,
      });

      await resolver.resolve("research");
      now += 6_000; // past TTL
      await resolver.resolve("research");

      expect(store.search).toHaveBeenCalledTimes(2);
    });

    it("caches parsed manifests by brickId", async () => {
      const brick = agentBrick();
      const store = createMockForgeStore({ ok: true, value: [brick] });
      // eslint-disable-next-line no-restricted-syntax -- justified: mutable for clock simulation
      let now = 1_000_000;
      const resolver = createCatalogAgentResolver({
        forgeStore: store,
        clock: () => now,
        cacheTtlMs: 1, // very short TTL to force re-search
      });

      const r1 = await resolver.resolve("research");
      now += 10; // past TTL, triggers new search but same brickId
      const r2 = await resolver.resolve("research");

      // Both should resolve successfully with same manifest
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      if (r1.ok && r2.ok) {
        expect(r1.value.manifest).toBe(r2.value.manifest); // same reference (cached)
      }
    });
  });

  describe("list", () => {
    it("returns summaries for all active agent bricks", async () => {
      const b1 = agentBrick({ name: "agent-a", description: "Agent A", tags: ["research"] });
      const b2 = agentBrick({
        id: brickId("brick_b"),
        name: "agent-b",
        description: "Agent B",
        tags: ["code"],
      });
      const store = createMockForgeStore({ ok: true, value: [b1, b2] });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const summaries = await resolver.list();

      expect(summaries).toHaveLength(2);
      expect(summaries[0]?.key).toBe("research");
      expect(summaries[0]?.name).toBe("agent-a");
      expect(summaries[1]?.key).toBe("code");
      expect(summaries[1]?.name).toBe("agent-b");
    });

    it("deduplicates by first tag", async () => {
      const b1 = agentBrick({ name: "agent-a", tags: ["research"] });
      const b2 = agentBrick({
        id: brickId("brick_dup"),
        name: "agent-b",
        tags: ["research"],
      });
      const store = createMockForgeStore({ ok: true, value: [b1, b2] });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const summaries = await resolver.list();

      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.name).toBe("agent-a");
    });

    it("returns empty array when store search fails", async () => {
      const store = createMockForgeStore({
        ok: false,
        error: { code: "EXTERNAL", message: "down", retryable: true },
      });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const summaries = await resolver.list();

      expect(summaries).toEqual([]);
    });

    it("uses brick name as key when tags are empty", async () => {
      const brick = agentBrick({ name: "orphan-agent", tags: [] });
      const store = createMockForgeStore({ ok: true, value: [brick] });
      const resolver = createCatalogAgentResolver({ forgeStore: store });

      const summaries = await resolver.list();

      expect(summaries).toHaveLength(1);
      expect(summaries[0]?.key).toBe("orphan-agent");
    });
  });
});

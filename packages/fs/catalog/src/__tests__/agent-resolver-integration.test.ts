/**
 * Integration tests for CatalogAgentResolver.
 *
 * Uses an in-memory ForgeStore mock to test the full resolve pipeline:
 * search → filter → select by fitness → parse manifest → return TaskableAgent.
 */

import { describe, expect, it, mock } from "bun:test";
import type { AgentArtifact, BrickArtifact, ForgeStore, KoiError, Result } from "@koi/core";
import { brickId } from "@koi/core";
import { createTestAgentArtifact } from "@koi/test-utils";

import { createCatalogAgentResolver } from "../agent-resolver.js";

// ---------------------------------------------------------------------------
// In-memory ForgeStore for integration tests
// ---------------------------------------------------------------------------

const VALID_YAML = `name: "test-agent"\nversion: "0.0.1"\nmodel: "mock-model"`;

function createInMemoryForgeStore(bricks: readonly BrickArtifact[]): ForgeStore {
  // eslint-disable-next-line no-restricted-syntax -- justified: mutable store for test
  const store = [...bricks];

  return {
    save: mock(async (brick: BrickArtifact) => {
      store.push(brick);
      return { ok: true, value: undefined } as Result<void, KoiError>;
    }),
    load: mock(async (id: string) => {
      const found = store.find((b) => b.id === id);
      if (found === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND", message: "not found", retryable: false },
        } as Result<BrickArtifact, KoiError>;
      }
      return { ok: true, value: found } as Result<BrickArtifact, KoiError>;
    }),
    search: mock(
      async (query: {
        readonly kind?: string;
        readonly tags?: readonly string[];
        readonly lifecycle?: string;
      }) => {
        const results = store.filter((b) => {
          if (query.kind !== undefined && b.kind !== query.kind) return false;
          if (query.lifecycle !== undefined && b.lifecycle !== query.lifecycle) return false;
          if (query.tags !== undefined && query.tags.length > 0) {
            const hasTags = query.tags.every((t) => b.tags.includes(t));
            if (!hasTags) return false;
          }
          return true;
        });
        return { ok: true, value: results } as Result<readonly BrickArtifact[], KoiError>;
      },
    ),
    remove: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    update: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    exists: mock(async () => ({ ok: true, value: false }) as Result<boolean, KoiError>),
  };
}

function agentBrick(
  name: string,
  tags: readonly string[],
  overrides: Partial<AgentArtifact> = {},
): BrickArtifact {
  return createTestAgentArtifact({
    id: brickId(`brick_${name}`),
    name,
    description: `${name} agent`,
    tags: [...tags],
    manifestYaml: VALID_YAML,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CatalogAgentResolver integration", () => {
  it("full pipeline: save bricks → resolve → returns correct TaskableAgent", async () => {
    const research = agentBrick("researcher", ["research"], {
      fitness: {
        successCount: 50,
        errorCount: 2,
        latency: { samples: [120], count: 1, cap: 200 },
        lastUsedAt: Date.now(),
      },
    });
    const coder = agentBrick("coder", ["code"], {
      fitness: {
        successCount: 30,
        errorCount: 0,
        latency: { samples: [80], count: 1, cap: 200 },
        lastUsedAt: Date.now(),
      },
    });
    const writer = agentBrick("writer", ["writing"]);

    const store = createInMemoryForgeStore([research, coder, writer]);
    const resolver = createCatalogAgentResolver({ forgeStore: store });

    // Resolve research type
    const researchResult = await resolver.resolve("research");
    expect(researchResult.ok).toBe(true);
    if (researchResult.ok) {
      expect(researchResult.value.name).toBe("researcher");
      expect(researchResult.value.brickId).toBe(brickId("brick_researcher"));
      expect(researchResult.value.manifest).toBeDefined();
      expect(researchResult.value.manifest.name).toBe("test-agent");
    }

    // Resolve code type
    const codeResult = await resolver.resolve("code");
    expect(codeResult.ok).toBe(true);
    if (codeResult.ok) {
      expect(codeResult.value.name).toBe("coder");
    }

    // Nonexistent type
    const missing = await resolver.resolve("nonexistent");
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.error.code).toBe("NOT_FOUND");
    }
  });

  it("variant selection picks higher-fitness brick more often", async () => {
    const now = Date.now();
    const highFit = agentBrick("high-fit", ["test"], {
      fitness: {
        successCount: 200,
        errorCount: 0,
        latency: { samples: [50], count: 1, cap: 200 },
        lastUsedAt: now,
      },
    });
    const lowFit = agentBrick("low-fit", ["test"], {
      fitness: {
        successCount: 1,
        errorCount: 50,
        latency: { samples: [5000], count: 1, cap: 200 },
        lastUsedAt: now - 86_400_000 * 90,
      },
    });

    const store = createInMemoryForgeStore([highFit, lowFit]);
    // eslint-disable-next-line no-restricted-syntax -- justified: mutable counter for stats
    let highCount = 0;
    const ITERATIONS = 50;

    for (let i = 0; i < ITERATIONS; i++) {
      const resolver = createCatalogAgentResolver({
        forgeStore: store,
        clock: () => now,
        cacheTtlMs: 0, // disable cache to get fresh selection each time
      });
      const result = await resolver.resolve("test");
      if (result.ok && result.value.name === "high-fit") {
        highCount++;
      }
    }

    // High-fitness brick should be selected significantly more often
    expect(highCount).toBeGreaterThan(ITERATIONS * 0.5);
  });

  it("list returns deduplicated summaries across all agent types", async () => {
    const r1 = agentBrick("researcher-v1", ["research"]);
    const r2 = agentBrick("researcher-v2", ["research"]); // duplicate type
    const c1 = agentBrick("coder-v1", ["code"]);

    const store = createInMemoryForgeStore([r1, r2, c1]);
    const resolver = createCatalogAgentResolver({ forgeStore: store });

    const summaries = await resolver.list();

    expect(summaries).toHaveLength(2);
    const keys = summaries.map((s) => s.key).sort();
    expect(keys).toEqual(["code", "research"]);
  });
});

/**
 * Integration tests for the forge → delegation bridge.
 *
 * Full pipeline: ForgeStore → CatalogAgentResolver → resolve → spawn with
 * fitness tracking.
 */

import { describe, expect, it, mock } from "bun:test";
import { createCatalogAgentResolver } from "@koi/catalog";
import type {
  AgentManifest,
  BrickArtifact,
  BrickFitnessMetrics,
  ForgeStore,
  KoiError,
  Result,
} from "@koi/core";
import { brickId } from "@koi/core";
import { createTestAgentArtifact } from "@koi/test-utils";

import {
  createSpawnFitnessWrapper,
  embedBrickId,
  type SpawnHealthRecorder,
} from "../spawn-fitness-wrapper.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_YAML = `name: "test-agent"\nversion: "0.0.1"\nmodel: "mock-model"`;

function createInMemoryForgeStore(bricks: readonly BrickArtifact[]): ForgeStore {
  // eslint-disable-next-line no-restricted-syntax -- justified: mutable for in-memory test store
  const store = [...bricks];

  return {
    save: mock(async () => ({ ok: true, value: undefined }) as Result<void, KoiError>),
    load: mock(
      async () =>
        ({
          ok: false,
          error: { code: "NOT_FOUND", message: "not found", retryable: false },
        }) as Result<BrickArtifact, KoiError>,
    ),
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

function createRecorder(): SpawnHealthRecorder & {
  readonly successCalls: Array<{ readonly id: string; readonly latencyMs: number }>;
  readonly failureCalls: Array<{
    readonly id: string;
    readonly latencyMs: number;
    readonly error: string;
  }>;
} {
  const successCalls: Array<{ readonly id: string; readonly latencyMs: number }> = [];
  const failureCalls: Array<{
    readonly id: string;
    readonly latencyMs: number;
    readonly error: string;
  }> = [];
  return {
    successCalls,
    failureCalls,
    recordSuccess: mock((id: string, latencyMs: number) => {
      successCalls.push({ id, latencyMs });
    }),
    recordFailure: mock((id: string, latencyMs: number, error: string) => {
      failureCalls.push({ id, latencyMs, error });
    }),
  };
}

interface TestSpawnRequest {
  readonly manifest: AgentManifest;
  readonly description: string;
  readonly agentName: string;
}

type TestSpawnResult =
  | { readonly ok: true; readonly output: string }
  | { readonly ok: false; readonly error: string };

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("forge → delegation bridge integration", () => {
  it("full flow: store → resolver → spawn with fitness tracking", async () => {
    // 1. Create ForgeStore with agent bricks
    const researchBrick = createTestAgentArtifact({
      id: brickId("brick_researcher"),
      name: "researcher",
      description: "Research agent",
      tags: ["research"],
      manifestYaml: VALID_YAML,
      fitness: {
        successCount: 50,
        errorCount: 2,
        latency: { samples: [120], count: 1, cap: 200 },
        lastUsedAt: Date.now(),
      } satisfies BrickFitnessMetrics,
    });

    const store = createInMemoryForgeStore([researchBrick]);

    // 2. Create resolver from store
    const resolver = createCatalogAgentResolver({ forgeStore: store });

    // 3. Resolve agent
    const resolveResult = await resolver.resolve("research");
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    const agent = resolveResult.value;
    expect(agent.name).toBe("researcher");
    expect(agent.brickId).toBe(brickId("brick_researcher"));

    // 4. Create spawn function with fitness wrapper
    const recorder = createRecorder();
    // eslint-disable-next-line no-restricted-syntax -- justified: mutable clock
    let now = 1000;
    const rawSpawn = mock(async (_req: TestSpawnRequest): Promise<TestSpawnResult> => {
      now += 300;
      return { ok: true, output: "research complete" };
    });

    const wrappedSpawn = createSpawnFitnessWrapper(rawSpawn, {
      healthRecorder: recorder,
      clock: () => now,
    });

    // 5. Spawn with brickId embedded in manifest metadata
    const enrichedManifest =
      agent.brickId !== undefined ? embedBrickId(agent.manifest, agent.brickId) : agent.manifest;

    const spawnResult = await wrappedSpawn({
      manifest: enrichedManifest,
      description: "do research",
      agentName: agent.name,
    });

    // 6. Verify spawn succeeded
    expect(spawnResult.ok).toBe(true);
    if (spawnResult.ok) {
      expect(spawnResult.output).toBe("research complete");
    }

    // 7. Verify fitness was recorded
    expect(recorder.successCalls).toHaveLength(1);
    expect(recorder.successCalls[0]?.id).toBe(brickId("brick_researcher"));
    expect(recorder.successCalls[0]?.latencyMs).toBe(300);
  });

  it("resolver NOT_FOUND → no spawn, no fitness recording", async () => {
    const store = createInMemoryForgeStore([]);
    const resolver = createCatalogAgentResolver({ forgeStore: store });

    const result = await resolver.resolve("nonexistent");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NOT_FOUND");
    }
  });

  it("spawn failure → fitness failure recorded", async () => {
    const brick = createTestAgentArtifact({
      id: brickId("brick_failing"),
      name: "failing-agent",
      tags: ["failing"],
      manifestYaml: VALID_YAML,
    });

    const store = createInMemoryForgeStore([brick]);
    const resolver = createCatalogAgentResolver({ forgeStore: store });

    const resolveResult = await resolver.resolve("failing");
    expect(resolveResult.ok).toBe(true);
    if (!resolveResult.ok) return;

    const recorder = createRecorder();
    const rawSpawn = mock(async (_req: TestSpawnRequest): Promise<TestSpawnResult> => {
      return { ok: false, error: "agent crashed" };
    });

    const wrappedSpawn = createSpawnFitnessWrapper(rawSpawn, {
      healthRecorder: recorder,
    });

    const agent = resolveResult.value;
    const enrichedManifest =
      agent.brickId !== undefined ? embedBrickId(agent.manifest, agent.brickId) : agent.manifest;

    const spawnResult = await wrappedSpawn({
      manifest: enrichedManifest,
      description: "do work",
      agentName: agent.name,
    });

    expect(spawnResult.ok).toBe(false);
    expect(recorder.failureCalls).toHaveLength(1);
    expect(recorder.failureCalls[0]?.id).toBe(brickId("brick_failing"));
    expect(recorder.failureCalls[0]?.error).toBe("agent crashed");
  });
});

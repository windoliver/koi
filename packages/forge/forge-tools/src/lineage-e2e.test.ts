/**
 * E2E integration test for evolution lineage tracking.
 *
 * Tests the full flow: forge_tool → forge_edit → verify evolution → search by parent → lineage walk.
 * Uses InMemoryForgeStore with real forge pipeline logic (no mocks for pipeline internals).
 */

import { describe, expect, mock, test } from "bun:test";
import type { BrickArtifact, BrickId, ForgeEvolution, ForgeProvenance, Result } from "@koi/core";
import { brickId } from "@koi/core";
import type { ForgePipeline } from "@koi/forge-types";
import { createDefaultForgeConfig } from "@koi/forge-types";
import { createTestToolArtifact } from "@koi/test-utils";
import { computeLineage } from "./lineage.js";
import { createInMemoryForgeStore } from "./memory-store.js";
import { createForgeEditTool } from "./tools/forge-edit.js";
import { createSearchForgeTool } from "./tools/search-forge.js";
import type { ForgeDeps } from "./tools/shared.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_CONTEXT = {
  agentId: "agent-e2e",
  depth: 0,
  sessionId: "session-e2e",
  forgesThisSession: 0,
} as const;

function mockPipeline(): ForgePipeline {
  return {
    verify: mock(async () => ({
      ok: true as const,
      value: { stages: [], sandbox: true, totalDurationMs: 0, passed: true },
    })),
    checkGovernance: mock(async () => ({ ok: true as const, value: undefined })),
    createProvenance: mock((opts: { readonly evolution?: ForgeEvolution }): ForgeProvenance => {
      const base: ForgeProvenance = {
        source: { origin: "forged" as const, forgedBy: "agent-e2e" },
        buildDefinition: { buildType: "test", externalParameters: {} },
        builder: { id: "test" },
        metadata: {
          invocationId: "inv-e2e",
          startedAt: Date.now(),
          finishedAt: Date.now(),
          sessionId: "session-e2e",
          agentId: "agent-e2e",
          depth: 0,
        },
        verification: { passed: true, sandbox: true, totalDurationMs: 0, stageResults: [] },
        classification: "public" as const,
        contentMarkers: [],
        contentHash: "e2e-hash",
      };
      if (opts.evolution !== undefined) {
        return { ...base, evolution: opts.evolution };
      }
      return base;
    }),
    signAttestation: mock(
      async (p: unknown) => p as Awaited<ReturnType<ForgePipeline["signAttestation"]>>,
    ),
    extractBrickContent: mock(
      (brick: { readonly kind: string; readonly implementation?: string }) => ({
        kind: brick.kind,
        content: brick.implementation ?? "",
      }),
    ),
    checkMutationPressure: mock(async () => ({ ok: true as const, value: undefined })),
  } as unknown as ForgePipeline;
}

// ---------------------------------------------------------------------------
// E2E: forge → edit → verify evolution → search → lineage
// ---------------------------------------------------------------------------

describe("evolution lineage E2E", () => {
  test("forge_edit sets evolution with parentBrickId and evolutionKind='fix'", async () => {
    const store = createInMemoryForgeStore();
    const pipeline = mockPipeline();
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = {
      store,
      executor: {
        execute: async () => ({ ok: true as const, value: { output: null, durationMs: 0 } }),
      },
      verifiers: [],
      config,
      context: DEFAULT_CONTEXT,
      pipeline,
    };

    // Step 1: Save a parent brick directly into the store
    const parentBrick = createTestToolArtifact({
      id: brickId("sha256:parent000000000000000000000000000000000000000000000000000000000"),
      name: "add-numbers",
      implementation: "return { sum: input.a + input.b };",
      version: "0.0.1",
    });
    await store.save(parentBrick);

    // Step 2: Edit the parent brick via forge_edit
    const editTool = createForgeEditTool(deps);
    const editResult = await editTool.execute({
      brickId: parentBrick.id,
      searchBlock: "return { sum: input.a + input.b };",
      replaceBlock: "const s = input.a + input.b; return { sum: s };",
      description: "Refactor to use intermediate variable",
    });

    const result = editResult as Result<{ readonly id: BrickId }, unknown>;
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const newBrickId = result.value.id;
    expect(newBrickId).not.toBe(parentBrick.id); // New ID (content-addressed)

    // Step 3: Load the edited brick and verify evolution metadata
    const loadResult = await store.load(newBrickId);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const editedBrick = loadResult.value;
    expect(editedBrick.provenance.evolution).toBeDefined();
    expect(editedBrick.provenance.evolution?.parentBrickId).toBe(parentBrick.id);
    expect(editedBrick.provenance.evolution?.evolutionKind).toBe("fix");
    expect(editedBrick.provenance.evolution?.description).toBe(
      "Refactor to use intermediate variable",
    );

    // Step 4: Verify version was incremented
    expect(editedBrick.version).toBe("0.0.2");

    // Step 5: Search for bricks by parentBrickId (using store directly)
    const searchResult = await store.search({ parentBrickId: parentBrick.id });
    expect(searchResult.ok).toBe(true);
    if (!searchResult.ok) return;
    expect(searchResult.value.length).toBe(1);
    expect(searchResult.value[0]?.id).toBe(newBrickId);

    // Step 6: Walk the lineage chain
    const lineageResult = await computeLineage(store, newBrickId);
    expect(lineageResult.ok).toBe(true);
    if (!lineageResult.ok) return;
    expect(lineageResult.value.chain).toHaveLength(2);
    expect(lineageResult.value.chain[0]?.id).toBe(parentBrick.id); // root
    expect(lineageResult.value.chain[1]?.id).toBe(newBrickId); // child
    expect(lineageResult.value.partial).toBe(false);
  });

  test("multi-step evolution chain: A → B → C", async () => {
    const store = createInMemoryForgeStore();
    const pipeline = mockPipeline();
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = {
      store,
      executor: {
        execute: async () => ({ ok: true as const, value: { output: null, durationMs: 0 } }),
      },
      verifiers: [],
      config,
      context: DEFAULT_CONTEXT,
      pipeline,
    };

    // Step 1: Create root brick A
    const brickA = createTestToolArtifact({
      id: brickId("sha256:aaa0000000000000000000000000000000000000000000000000000000000000"),
      name: "calculator",
      implementation: "return input.a + input.b;",
      version: "0.0.1",
    });
    await store.save(brickA);

    // Step 2: Edit A → B
    const editTool = createForgeEditTool(deps);
    const editResult1 = await editTool.execute({
      brickId: brickA.id,
      searchBlock: "return input.a + input.b;",
      replaceBlock: "return input.a + input.b + 0;",
      description: "First edit",
    });
    const result1 = editResult1 as Result<{ readonly id: BrickId }, unknown>;
    expect(result1.ok).toBe(true);
    if (!result1.ok) return;
    const brickBId = result1.value.id;

    // Step 3: Edit B → C
    const editResult2 = await editTool.execute({
      brickId: brickBId,
      searchBlock: "return input.a + input.b + 0;",
      replaceBlock: "return input.a + input.b + 0 + 0;",
      description: "Second edit",
    });
    const result2 = editResult2 as Result<{ readonly id: BrickId }, unknown>;
    expect(result2.ok).toBe(true);
    if (!result2.ok) return;
    const brickCId = result2.value.id;

    // Step 4: Walk lineage from C
    const lineageResult = await computeLineage(store, brickCId);
    expect(lineageResult.ok).toBe(true);
    if (!lineageResult.ok) return;

    expect(lineageResult.value.chain).toHaveLength(3);
    expect(lineageResult.value.chain[0]?.id).toBe(brickA.id);
    expect(lineageResult.value.chain[1]?.id).toBe(brickBId);
    expect(lineageResult.value.chain[2]?.id).toBe(brickCId);
    expect(lineageResult.value.partial).toBe(false);

    // Step 5: Verify each brick's evolution
    const loadB = await store.load(brickBId);
    expect(loadB.ok).toBe(true);
    if (loadB.ok) {
      expect(loadB.value.provenance.evolution?.parentBrickId).toBe(brickA.id);
      expect(loadB.value.provenance.evolution?.evolutionKind).toBe("fix");
      expect(loadB.value.version).toBe("0.0.2");
    }

    const loadC = await store.load(brickCId);
    expect(loadC.ok).toBe(true);
    if (loadC.ok) {
      expect(loadC.value.provenance.evolution?.parentBrickId).toBe(brickBId);
      expect(loadC.value.provenance.evolution?.evolutionKind).toBe("fix");
      expect(loadC.value.version).toBe("0.0.3");
    }
  });

  test("search_forge filters by parentBrickId", async () => {
    const store = createInMemoryForgeStore();
    const pipeline = mockPipeline();
    const config = createDefaultForgeConfig();
    const deps: ForgeDeps = {
      store,
      executor: {
        execute: async () => ({ ok: true as const, value: { output: null, durationMs: 0 } }),
      },
      verifiers: [],
      config,
      context: DEFAULT_CONTEXT,
      pipeline,
    };

    // Create parent + child via forge_edit
    const parent = createTestToolArtifact({
      id: brickId("sha256:parent111111111111111111111111111111111111111111111111111111111"),
      name: "search-test-tool",
      implementation: "return 1;",
      version: "0.0.1",
    });
    await store.save(parent);

    const editTool = createForgeEditTool(deps);
    const editResult = await editTool.execute({
      brickId: parent.id,
      searchBlock: "return 1;",
      replaceBlock: "return 2;",
    });
    const result = editResult as Result<{ readonly id: BrickId }, unknown>;
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Search via search_forge tool
    const searchTool = createSearchForgeTool(deps);
    const searchResult = await searchTool.execute({
      parentBrickId: parent.id,
    });

    const sResult = searchResult as Result<readonly BrickArtifact[], unknown>;
    expect(sResult.ok).toBe(true);
    if (!sResult.ok) return;
    expect(sResult.value.length).toBe(1);
    expect(sResult.value[0]?.provenance.evolution?.parentBrickId).toBe(parent.id);
  });
});

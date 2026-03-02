/**
 * Integration test — compose_forge pipeline semantics.
 *
 * Tests the full flow: store → load → validate → compute ID → save → roundtrip.
 * Uses in-memory mock store, no external dependencies.
 */

import { describe, expect, mock, test } from "bun:test";
import type {
  BrickArtifact,
  CompositeArtifact,
  ForgeStore,
  Result,
  SandboxExecutor,
  TieredSandboxExecutor,
} from "@koi/core";
import { brickId } from "@koi/core";
import { createTestToolArtifact } from "@koi/test-utils";
import { createDefaultForgeConfig } from "../src/config.js";
import type { ForgeError } from "../src/errors.js";
import { createComposeForge } from "../src/tools/compose-forge.js";
import type { ForgeDeps } from "../src/tools/shared.js";
import type { ForgeResult } from "../src/types.js";

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

function createInMemoryStore(): ForgeStore & { readonly data: Map<string, BrickArtifact> } {
  const data = new Map<string, BrickArtifact>();
  return {
    data,
    save: async (brick: BrickArtifact) => {
      data.set(brick.id, brick);
      return { ok: true, value: undefined };
    },
    load: async (id) => {
      const brick = data.get(id);
      if (brick === undefined) {
        return {
          ok: false,
          error: { code: "NOT_FOUND" as const, message: `Not found: ${id}`, retryable: false },
        };
      }
      return { ok: true, value: brick };
    },
    search: async () => ({ ok: true, value: [] }),
    remove: async (id) => {
      data.delete(id);
      return { ok: true, value: undefined };
    },
    update: async () => ({ ok: true, value: undefined }),
    exists: async (id) => ({ ok: true, value: data.has(id) }),
  } as ForgeStore & { readonly data: Map<string, BrickArtifact> };
}

function createMockExecutor(): TieredSandboxExecutor {
  const executor: SandboxExecutor = {
    execute: mock(async () => ({
      ok: true as const,
      value: { output: "test", durationMs: 10 },
    })),
  };
  return {
    forTier: () => ({
      executor,
      requestedTier: "sandbox",
      resolvedTier: "sandbox",
      fallback: false,
    }),
  };
}

function createDeps(store: ForgeStore): ForgeDeps {
  return {
    store,
    executor: createMockExecutor(),
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe("compose_forge integration", () => {
  test("full pipeline: save bricks → compose → verify composite → roundtrip", async () => {
    const store = createInMemoryStore();

    // 1. Pre-populate store with two tool artifacts
    const toolA = createTestToolArtifact({
      id: brickId("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      name: "fetch-data",
      inputSchema: { type: "object", properties: { url: { type: "string" } } },
    });
    const toolB = createTestToolArtifact({
      id: brickId("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      name: "parse-json",
      inputSchema: { type: "object", properties: { data: { type: "string" } } },
    });
    await store.save(toolA);
    await store.save(toolB);

    // 2. Compose pipeline
    const deps = createDeps(store);
    const composeTool = createComposeForge(deps);
    const result = (await composeTool.execute({
      name: "fetch-and-parse",
      description: "Fetches then parses",
      brickIds: [toolA.id, toolB.id],
      tags: ["composite", "pipeline"],
    })) as Result<ForgeResult, ForgeError>;

    // 3. Verify result shape
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.kind).toBe("composite");
    expect(result.value.name).toBe("fetch-and-parse");
    expect(result.value.forgesConsumed).toBe(1);
    expect(result.value.id).toMatch(/^sha256:[0-9a-f]{64}$/);

    // 4. Load back from store and verify roundtrip
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (!loadResult.ok) return;

    const composite = loadResult.value;
    expect(composite.kind).toBe("composite");
    if (composite.kind !== "composite") return;

    const typedComposite: CompositeArtifact = composite;
    expect(typedComposite.steps).toHaveLength(2);
    expect(typedComposite.steps[0]?.brickId).toBe(toolA.id);
    expect(typedComposite.steps[1]?.brickId).toBe(toolB.id);
    expect(typedComposite.outputKind).toBe("tool");
    expect(typedComposite.exposedInput.schema).toEqual({
      type: "object",
      properties: { url: { type: "string" } },
    });
    expect(typedComposite.exposedOutput.schema).toEqual({ type: "object" });
    expect(typedComposite.name).toBe("fetch-and-parse");
    expect(typedComposite.tags).toEqual(["composite", "pipeline"]);
  });

  test("dedup: composing same bricks twice returns same ID without re-saving", async () => {
    const store = createInMemoryStore();

    const toolA = createTestToolArtifact({
      id: brickId("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      name: "step-a",
    });
    const toolB = createTestToolArtifact({
      id: brickId("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      name: "step-b",
    });
    await store.save(toolA);
    await store.save(toolB);

    const deps = createDeps(store);
    const composeTool = createComposeForge(deps);

    // First compose
    const result1 = (await composeTool.execute({
      name: "dedup-test",
      description: "test",
      brickIds: [toolA.id, toolB.id],
    })) as Result<ForgeResult, ForgeError>;
    expect(result1.ok).toBe(true);

    // Second compose — should hit dedup
    const result2 = (await composeTool.execute({
      name: "dedup-test",
      description: "test",
      brickIds: [toolA.id, toolB.id],
    })) as Result<ForgeResult, ForgeError>;
    expect(result2.ok).toBe(true);

    if (result1.ok && result2.ok) {
      expect(result1.value.id).toBe(result2.value.id);
      expect(result2.value.forgesConsumed).toBe(0); // Dedup — no forge consumed
    }
  });

  test("order matters: A→B has different ID than B→A", async () => {
    const store = createInMemoryStore();

    const toolA = createTestToolArtifact({
      id: brickId("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"),
      name: "step-a",
    });
    const toolB = createTestToolArtifact({
      id: brickId("sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
      name: "step-b",
    });
    await store.save(toolA);
    await store.save(toolB);

    const deps = createDeps(store);
    const composeTool = createComposeForge(deps);

    const resultAB = (await composeTool.execute({
      name: "ab",
      description: "A then B",
      brickIds: [toolA.id, toolB.id],
    })) as Result<ForgeResult, ForgeError>;

    const resultBA = (await composeTool.execute({
      name: "ba",
      description: "B then A",
      brickIds: [toolB.id, toolA.id],
    })) as Result<ForgeResult, ForgeError>;

    expect(resultAB.ok).toBe(true);
    expect(resultBA.ok).toBe(true);
    if (resultAB.ok && resultBA.ok) {
      expect(resultAB.value.id).not.toBe(resultBA.value.id);
    }
  });
});

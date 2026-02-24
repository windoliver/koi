import { describe, expect, test } from "bun:test";
import type { SandboxExecutor, TieredSandboxExecutor, ToolArtifact } from "@koi/core";
import { createDefaultForgeConfig } from "../config.js";
import { createInMemoryForgeStore } from "../memory-store.js";
import type { CompositionMetadata, ForgeResult } from "../types.js";
import { createComposeForgeTool } from "./compose-forge.js";
import type { ForgeDeps } from "./shared.js";

function createToolBrick(overrides?: Partial<ToolArtifact>): ToolArtifact {
  return {
    id: `brick_${Math.random().toString(36).slice(2, 10)}`,
    kind: "tool",
    name: "test-brick",
    description: "A test brick",
    scope: "agent",
    trustTier: "sandbox",
    lifecycle: "active",
    createdBy: "agent-1",
    createdAt: Date.now(),
    version: "0.0.1",
    tags: [],
    usageCount: 0,
    contentHash: "test-hash",
    implementation: "return 1;",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function mockTiered(exec: SandboxExecutor): TieredSandboxExecutor {
  return {
    forTier: (tier) => ({
      executor: exec,
      requestedTier: tier,
      resolvedTier: tier,
      fallback: false,
    }),
  };
}

function createDeps(overrides?: Partial<ForgeDeps>): ForgeDeps {
  return {
    store: createInMemoryForgeStore(),
    executor: mockTiered({
      execute: async () => ({ ok: true, value: { output: "ok", durationMs: 1 } }),
    }),
    verifiers: [],
    config: createDefaultForgeConfig(),
    context: { agentId: "agent-1", depth: 0, sessionId: "session-1", forgesThisSession: 0 },
    ...overrides,
  };
}

describe("createComposeForgeTool", () => {
  test("has correct descriptor", () => {
    const tool = createComposeForgeTool(createDeps());
    expect(tool.descriptor.name).toBe("compose_forge");
  });

  test("composes bricks and saves to store", async () => {
    const store = createInMemoryForgeStore();
    const brick1 = createToolBrick({ id: "brick_aaa" });
    const brick2 = createToolBrick({ id: "brick_bbb", name: "second-brick" });
    await store.save(brick1);
    await store.save(brick2);

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite of two bricks",
      brickIds: ["brick_aaa", "brick_bbb"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.kind).toBe("composite");
    expect(result.value.name).toBe("myComposite");
    expect(result.value.lifecycle).toBe("active");

    // Verify saved in store
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      expect(loadResult.value.kind).toBe("composite");
      if (loadResult.value.kind === "composite") {
        expect(loadResult.value.brickIds).toEqual(["brick_aaa", "brick_bbb"]);
      }
    }
  });

  test("returns verification report in result", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_aaa" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_aaa"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.verificationReport.stages).toHaveLength(4);
    expect(result.value.verificationReport.passed).toBe(true);
  });

  test("includes metadata in result", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_aaa" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_aaa"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.metadata.forgedBy).toBe("agent-1");
    expect(result.value.metadata.sessionId).toBe("session-1");
  });

  test("returns forgesConsumed = 1 on success", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_aaa" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_aaa"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.forgesConsumed).toBe(1);
  });

  // --- Input validation ---

  test("rejects null input with validation error", async () => {
    const tool = createComposeForgeTool(createDeps());
    const result = (await tool.execute(null as unknown as Record<string, unknown>)) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("MISSING_FIELD");
  });

  test("rejects input missing required fields", async () => {
    const tool = createComposeForgeTool(createDeps());
    const result = (await tool.execute({ name: "comp" })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.message).toContain("description");
  });

  test("rejects input with wrong field type", async () => {
    const tool = createComposeForgeTool(createDeps());
    const result = (await tool.execute({
      name: 123,
      description: "A composite",
      brickIds: ["brick_aaa"],
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.code).toBe("INVALID_TYPE");
    expect(result.error.message).toContain("name");
  });

  test("returns error for invalid name", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_aaa" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "x",
      description: "A composite",
      brickIds: ["brick_aaa"],
    })) as { readonly ok: false; readonly error: { readonly stage: string } };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
  });

  // --- Brick existence validation ---

  test("returns error when referenced brick does not exist", async () => {
    const store = createInMemoryForgeStore();
    // Store is empty — no bricks saved

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_nonexistent"],
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("LOAD_FAILED");
    expect(result.error.message).toContain("brick_nonexistent");
  });

  test("returns error when one of multiple bricks does not exist", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_exists" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_exists", "brick_missing"],
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("LOAD_FAILED");
    expect(result.error.message).toContain("brick_missing");
  });

  test("returns error for duplicate brick IDs", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_dup" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_dup", "brick_dup"],
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string; readonly message: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("static");
    expect(result.error.message).toContain("duplicate");
  });

  // --- Store failure ---

  test("returns store error on save failure", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_aaa" }));

    // Override save to fail after loading succeeds
    const failingSaveStore = {
      ...store,
      save: async () => ({
        ok: false as const,
        error: { code: "INTERNAL" as const, message: "disk full", retryable: false },
      }),
    };

    const tool = createComposeForgeTool(createDeps({ store: failingSaveStore }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_aaa"],
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("store");
    expect(result.error.code).toBe("SAVE_FAILED");
  });

  // --- Governance ---

  test("rejects when forge is disabled", async () => {
    const config = createDefaultForgeConfig({ enabled: false });
    const tool = createComposeForgeTool(createDeps({ config }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_aaa"],
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("FORGE_DISABLED");
  });

  test("rejects at depth 1 (compose_forge not allowed)", async () => {
    const config = createDefaultForgeConfig({ maxForgeDepth: 2 });
    const context = { agentId: "agent-1", depth: 1, sessionId: "session-1", forgesThisSession: 0 };
    const tool = createComposeForgeTool(createDeps({ config, context }));
    const result = (await tool.execute({
      name: "myComposite",
      description: "A composite",
      brickIds: ["brick_aaa"],
    })) as {
      readonly ok: false;
      readonly error: { readonly stage: string; readonly code: string };
    };

    expect(result.ok).toBe(false);
    expect(result.error.stage).toBe("governance");
    expect(result.error.code).toBe("DEPTH_TOOL_RESTRICTED");
  });

  // --- Trust propagation ---

  test("sandbox + sandbox → sandbox trust", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_s1", trustTier: "sandbox" }));
    await store.save(createToolBrick({ id: "brick_s2", trustTier: "sandbox" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "sandboxComposite",
      description: "Two sandbox bricks",
      brickIds: ["brick_s1", "brick_s2"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.trustTier).toBe("sandbox");
  });

  test("sandbox + verified → sandbox (min)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_s3", trustTier: "sandbox" }));
    await store.save(createToolBrick({ id: "brick_v1", trustTier: "verified" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "mixedComposite",
      description: "sandbox + verified",
      brickIds: ["brick_s3", "brick_v1"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    expect(result.value.trustTier).toBe("sandbox");
  });

  test("verified + promoted → verified (min)", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_v2", trustTier: "verified" }));
    await store.save(createToolBrick({ id: "brick_p1", trustTier: "promoted" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "highComposite",
      description: "verified + promoted",
      brickIds: ["brick_v2", "brick_p1"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    // Pipeline assigns "sandbox" by default, and min(sandbox, verified) = sandbox
    // But the trust from components: min(verified, promoted) = verified
    // So overall trust = min(pipeline=sandbox, components=verified) = sandbox
    expect(result.value.trustTier).toBe("sandbox");
  });

  // --- Composition metadata ---

  test("stores composition metadata in _composition.json", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_m1", name: "calc", trustTier: "sandbox" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "metaComposite",
      description: "Composite with metadata",
      brickIds: ["brick_m1"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    expect(loadResult.ok).toBe(true);
    if (loadResult.ok) {
      const compositionJson = loadResult.value.files?.["_composition.json"];
      expect(compositionJson).toBeDefined();
      if (compositionJson !== undefined) {
        const metadata = JSON.parse(compositionJson) as CompositionMetadata;
        expect(metadata.bricks).toHaveLength(1);
        expect(metadata.bricks[0]?.name).toBe("calc");
        expect(metadata.bricks[0]?.kind).toBe("tool");
        expect(metadata.bricks[0]?.trustTier).toBe("sandbox");
        expect(metadata.minimumTrustTier).toBe("sandbox");
      }
    }
  });

  // --- Tags propagation ---

  test("propagates tags to composite artifact", async () => {
    const store = createInMemoryForgeStore();
    await store.save(createToolBrick({ id: "brick_t1" }));

    const tool = createComposeForgeTool(createDeps({ store }));
    const result = (await tool.execute({
      name: "taggedComposite",
      description: "Composite with tags",
      brickIds: ["brick_t1"],
      tags: ["group", "v1"],
    })) as { readonly ok: true; readonly value: ForgeResult };

    expect(result.ok).toBe(true);
    const loadResult = await store.load(result.value.id);
    if (loadResult.ok) {
      expect(loadResult.value.tags).toEqual(["group", "v1"]);
    }
  });
});
